import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { initDatabase } from './database.js'
import { TurnRunner } from './turn-runner.js'
import type { TurnAgentLike, TurnEvent } from './turn-runner.js'
import type { ResponseChunk } from './agent-runtime-types.js'
import { PROVIDER_STALL_KIND } from './provider-stall.js'
import type { ProviderStallMetadata } from './provider-stall.js'
import type { Database } from './database.js'

const SESSION_ID = 'session-turn-runner'
const USER_ID = 7

interface ChatRow {
  role: string
  content: string
  metadata: string | null
}

function rows(db: Database): ChatRow[] {
  return db.prepare(
    'SELECT role, content, metadata FROM chat_messages WHERE session_id = ? ORDER BY id'
  ).all(SESSION_ID) as ChatRow[]
}

interface StallRow {
  id: number
  content: string
  metadata: ProviderStallMetadata
}

function stallRows(db: Database): StallRow[] {
  const all = db.prepare(
    'SELECT id, role, content, metadata FROM chat_messages WHERE session_id = ? ORDER BY id'
  ).all(SESSION_ID) as Array<{ id: number; role: string; content: string; metadata: string | null }>

  return all
    .map(r => ({ id: r.id, content: r.content, metadata: JSON.parse(r.metadata ?? '{}') as ProviderStallMetadata }))
    .filter(r => r.metadata.kind === PROVIDER_STALL_KIND)
}

function stallChunks(events: TurnEvent[]): ResponseChunk[] {
  return events
    .filter(e => e.type === 'chunk')
    .map(e => (e as { chunk: ResponseChunk }).chunk)
    .filter(c => c.type === 'stall_warning' || c.type === 'stall_resolved')
}

/** Points config lookups at an isolated `settings.json` for the test. */
function useSettingsFile(settings: Record<string, unknown>): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-turn-runner-'))
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'config', 'settings.json'), JSON.stringify(settings), 'utf-8')
  process.env.DATA_DIR = dir
}

function freshDb(): Database {
  const db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(USER_ID, 'tester', 'x')
  return db
}

/** An agent whose stream is driven manually so tests control chunk timing. */
function controllableAgent() {
  const queue: ResponseChunk[] = []
  const waiters: Array<() => void> = []
  let done = false
  let failure: Error | null = null

  const wake = () => { while (waiters.length) waiters.shift()!() }

  const push = (chunk: ResponseChunk) => { queue.push(chunk); wake() }
  const finish = () => { done = true; wake() }
  const fail = (err: Error) => { failure = err; wake() }

  const agent: TurnAgentLike = {
    sendMessage: async function* () {
      for (;;) {
        while (queue.length > 0) yield queue.shift()!
        if (failure) throw failure
        if (done) return
        await new Promise<void>((resolve) => { waiters.push(resolve) })
      }
    },
    abort: vi.fn(() => { done = true; wake() }),
  }

  return { agent, push, finish, fail }
}

function scriptedAgent(chunks: ResponseChunk[]): TurnAgentLike {
  return {
    sendMessage: async function* () {
      for (const chunk of chunks) yield chunk
    },
    abort: vi.fn(),
  }
}

function collect(events: TurnEvent[]) {
  return (event: TurnEvent) => { events.push(event) }
}

function chunkTypes(events: TurnEvent[]): string[] {
  return events.filter(e => e.type === 'chunk').map(e => (e as { chunk: ResponseChunk }).chunk.type)
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
}

function startRunner(db: Database, agent: TurnAgentLike | null, overrides = {}) {
  return new TurnRunner({ db, getAgent: () => agent, ...overrides })
}

describe('TurnRunner', () => {
  it('replays the buffered partial turn to a consumer that attaches mid-turn, then continues live', async () => {
    const db = freshDb()
    const { agent, push, finish } = controllableAgent()
    const runner = startRunner(db, agent)

    const first: TurnEvent[] = []
    const detachFirst = runner.subscribe(USER_ID, collect(first))
    runner.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'hi' })

    push({ type: 'thinking', thinking: 'Hmm,' })
    push({ type: 'text', text: 'Partial' })
    await waitFor(() => chunkTypes(first).length === 2)

    // The driving consumer disappears (page reload / socket drop).
    detachFirst()

    const late: TurnEvent[] = []
    runner.subscribe(USER_ID, collect(late))

    // Replay: turn_start + both chunks so far, all flagged as replay.
    expect(late.map(e => e.type)).toEqual(['turn_start', 'chunk', 'chunk'])
    expect(late.every(e => e.replay === true)).toBe(true)
    expect(chunkTypes(late)).toEqual(['thinking', 'text'])

    // …and then live continuation on the same subscription.
    push({ type: 'text', text: ' rest' })
    push({ type: 'done' })
    finish()
    await waitFor(() => late.some(e => e.type === 'turn_end'))

    const liveTexts = late
      .filter(e => e.type === 'chunk' && !e.replay)
      .map(e => (e as { chunk: ResponseChunk }).chunk)
      .filter(c => c.type === 'text')
      .map(c => c.text)
    expect(liveTexts).toEqual([' rest'])

    // The turn kept running while nobody was attached, and the full response
    // (both halves) was persisted.
    const assistant = rows(db).filter(r => r.role === 'assistant' && !r.metadata)
    expect(assistant).toHaveLength(1)
    expect(assistant[0]!.content).toBe('Partial rest')
  })

  it('delivers identical streams to multiple concurrent subscribers', async () => {
    const db = freshDb()
    const runner = startRunner(db, scriptedAgent([
      { type: 'thinking', thinking: 'think' },
      { type: 'text', text: 'answer' },
      { type: 'done' },
    ]))

    const tabA: TurnEvent[] = []
    const tabB: TurnEvent[] = []
    runner.subscribe(USER_ID, collect(tabA))
    runner.subscribe(USER_ID, collect(tabB))

    runner.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'hi' })
    await waitFor(() => tabA.some(e => e.type === 'turn_end'))

    expect(chunkTypes(tabA)).toEqual(['thinking', 'text', 'done'])
    expect(tabB).toEqual(tabA)
  })

  it('keeps the turn running and persists the response when every consumer detaches', async () => {
    const db = freshDb()
    const { agent, push, finish } = controllableAgent()
    const runner = startRunner(db, agent)

    const events: TurnEvent[] = []
    const detach = runner.subscribe(USER_ID, collect(events))
    runner.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'hi' })

    push({ type: 'text', text: 'start' })
    await waitFor(() => chunkTypes(events).length === 1)
    detach()

    expect(runner.hasActiveTurn(USER_ID)).toBe(true)
    expect(agent.abort).not.toHaveBeenCalled()

    push({ type: 'text', text: '-end' })
    push({ type: 'done' })
    finish()
    await waitFor(() => !runner.hasActiveTurn(USER_ID))

    const assistant = rows(db).filter(r => r.role === 'assistant')
    expect(assistant).toHaveLength(1)
    expect(assistant[0]!.content).toBe('start-end')
  })

  it('persists thinking, tool and assistant rows in stream order', async () => {
    const db = freshDb()
    const runner = startRunner(db, scriptedAgent([
      { type: 'thinking', thinking: 'Hmm,' },
      { type: 'thinking', thinking: ' ok.' },
      { type: 'tool_call_start', toolName: 'search', toolCallId: 'tc-1', toolArgs: { q: 'x' } },
      { type: 'tool_call_end', toolName: 'search', toolCallId: 'tc-1', toolResult: { ok: true } },
      { type: 'text', text: 'Answer.' },
      { type: 'done' },
    ]))

    runner.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'hi' })
    await waitFor(() => !runner.hasActiveTurn(USER_ID))

    const persisted = rows(db)
    expect(persisted.map(r => r.role)).toEqual(['assistant', 'tool', 'assistant'])

    expect(JSON.parse(persisted[0]!.metadata!)).toEqual({ kind: 'thinking' })
    expect(persisted[0]!.content).toBe('Hmm, ok.')

    expect(persisted[1]!.content).toBe('Tool: search')
    expect(JSON.parse(persisted[1]!.metadata!)).toEqual({
      toolName: 'search',
      toolCallId: 'tc-1',
      toolArgs: { q: 'x' },
      toolResult: { ok: true },
      toolIsError: false,
    })

    expect(persisted[2]!.content).toBe('Answer.')
    expect(persisted[2]!.metadata).toBeNull()
  })

  it('emits an attachment event and merges uploads into the assistant row metadata', async () => {
    const db = freshDb()
    const upload = {
      kind: 'file' as const,
      originalName: 'report.md',
      storedName: 'abc-report.md',
      relativePath: '2026/04/20/abc-report.md',
      urlPath: '/api/uploads/2026/04/20/abc-report.md',
      mimeType: 'text/markdown',
      size: 42,
    }
    const runner = startRunner(db, scriptedAgent([
      { type: 'tool_call_start', toolName: 'send_file_to_user', toolCallId: 'tc-1' },
      { type: 'tool_call_end', toolName: 'send_file_to_user', toolCallId: 'tc-1', toolResult: { details: { uploadedFile: upload } } },
      { type: 'text', text: 'Here you go.' },
      { type: 'done' },
    ]))

    const events: TurnEvent[] = []
    runner.subscribe(USER_ID, collect(events))
    runner.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'file please' })
    await waitFor(() => !runner.hasActiveTurn(USER_ID))

    const attachments = events.filter(e => e.type === 'attachment')
    expect(attachments).toHaveLength(1)

    const assistantRow = rows(db).find(r => r.role === 'assistant')!
    const meta = JSON.parse(assistantRow.metadata!) as { files: Array<{ relativePath: string }> }
    expect(meta.files[0]!.relativePath).toBe(upload.relativePath)
  })

  it('aborts the running turn, propagates the abort to the agent and still emits done', async () => {
    const db = freshDb()
    const { agent, push } = controllableAgent()
    const runner = startRunner(db, agent)

    const events: TurnEvent[] = []
    runner.subscribe(USER_ID, collect(events))
    runner.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'hi' })

    push({ type: 'thinking', thinking: 'half a thought' })
    await waitFor(() => chunkTypes(events).length === 1)

    expect(runner.abortTurn(USER_ID)).toBe(true)
    expect(agent.abort).toHaveBeenCalledTimes(1)
    await waitFor(() => !runner.hasActiveTurn(USER_ID))

    expect(chunkTypes(events)).toEqual(['thinking', 'done'])
    // Partial reasoning survives the abort so a reload shows what happened.
    const thinkingRow = rows(db).find(r => r.metadata?.includes('thinking'))
    expect(thinkingRow!.content).toBe('half a thought')
    // No assistant text was produced, so no empty assistant row is written.
    expect(rows(db).filter(r => r.role === 'assistant' && !r.metadata)).toHaveLength(0)

    expect(runner.abortTurn(USER_ID)).toBe(false)
  })

  it('reports an agent error as an error chunk followed by done', async () => {
    const db = freshDb()
    const runner = startRunner(db, {
      sendMessage: async function* (): AsyncGenerator<ResponseChunk> {
        yield { type: 'text', text: 'partial' }
        throw new Error('provider exploded')
      },
      abort: vi.fn(),
    })

    const events: TurnEvent[] = []
    runner.subscribe(USER_ID, collect(events))
    runner.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'hi' })
    await waitFor(() => !runner.hasActiveTurn(USER_ID))

    expect(chunkTypes(events)).toEqual(['text', 'error', 'done'])
    const errorChunk = events.find(e => e.type === 'chunk' && e.chunk.type === 'error') as { chunk: ResponseChunk }
    expect(errorChunk.chunk.error).toContain('provider exploded')
  })

  it('does not replay or resurrect anything for a fresh runner over the same database', async () => {
    const db = freshDb()
    const { agent, push } = controllableAgent()
    const runner = startRunner(db, agent)

    runner.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'hi' })
    push({ type: 'thinking', thinking: 'mid-flight' })
    push({ type: 'text', text: 'partial answer' })
    await waitFor(() => rows(db).length === 1)

    const rowsBefore = rows(db).length

    // Simulate a backend restart: a brand-new runner over the same DB.
    const restarted = startRunner(db, agent)
    const events: TurnEvent[] = []
    restarted.subscribe(USER_ID, collect(events))

    expect(events).toEqual([])
    expect(restarted.hasActiveTurn(USER_ID)).toBe(false)
    expect(rows(db)).toHaveLength(rowsBefore)
  })

  it('replays a just-finished turn inside the retention window and nothing after it', async () => {
    const db = freshDb()
    const runner = startRunner(db, scriptedAgent([
      { type: 'text', text: 'done already' },
      { type: 'done' },
    ]), { completedTurnRetentionMs: 60_000 })

    runner.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'hi' })
    await waitFor(() => !runner.hasActiveTurn(USER_ID))

    const reconnect: TurnEvent[] = []
    runner.subscribe(USER_ID, collect(reconnect))
    expect(reconnect.map(e => e.type)).toEqual(['turn_start', 'chunk', 'chunk', 'turn_end'])
    expect(reconnect.every(e => e.replay === true)).toBe(true)

    const expired = startRunner(db, scriptedAgent([{ type: 'done' }]), { completedTurnRetentionMs: 0 })
    expired.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'hi' })
    await waitFor(() => !expired.hasActiveTurn(USER_ID))
    const nothing: TurnEvent[] = []
    expired.subscribe(USER_ID, collect(nothing))
    expect(nothing).toEqual([])
  })

  it('serializes concurrent turns for the same user', async () => {
    const db = freshDb()
    const seen: string[] = []
    const runner = startRunner(db, {
      sendMessage: async function* (_userId: string, text: string): AsyncGenerator<ResponseChunk> {
        seen.push(`start:${text}`)
        await new Promise<void>((resolve) => setTimeout(resolve, 10))
        yield { type: 'text', text }
        yield { type: 'done' }
        seen.push(`end:${text}`)
      },
      abort: vi.fn(),
    })

    runner.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'one' })
    runner.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'two' })
    await waitFor(() => !runner.hasActiveTurn(USER_ID), 2000)

    expect(seen).toEqual(['start:one', 'end:one', 'start:two', 'end:two'])
    expect(rows(db).map(r => r.content)).toEqual(['one', 'two'])
  })


  describe('stall watchdog', () => {
    const originalDataDir = process.env.DATA_DIR

    afterEach(() => {
      vi.useRealTimers()
      if (originalDataDir === undefined) delete process.env.DATA_DIR
      else process.env.DATA_DIR = originalDataDir
    })

    it('warns, persists a provider_stall row and resolves it in place when the provider recovers', async () => {
      vi.useFakeTimers()
      const db = freshDb()
      const { agent, push, finish } = controllableAgent()
      const runner = startRunner(db, agent, {
        stallWarnMs: 30_000,
        stallAbortMs: 90_000,
        watchdogIntervalMs: 1_000,
      })

      const events: TurnEvent[] = []
      runner.subscribe(USER_ID, collect(events))
      runner.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'hi' })
      await vi.advanceTimersByTimeAsync(0)

      // Nothing yet — the provider is merely slow, not stalled.
      await vi.advanceTimersByTimeAsync(29_000)
      expect(stallChunks(events)).toEqual([])

      await vi.advanceTimersByTimeAsync(2_000)
      const [warning] = stallChunks(events)
      expect(warning?.type).toBe('stall_warning')

      const persistedOnWarn = stallRows(db)
      expect(persistedOnWarn).toHaveLength(1)
      expect(persistedOnWarn[0]!.content).toContain('Provider has not responded')
      expect(persistedOnWarn[0]!.metadata.outcome).toBeNull()
      expect(persistedOnWarn[0]!.metadata.resolvedAt).toBeNull()
      expect(persistedOnWarn[0]!.metadata.durationMs).toBeGreaterThanOrEqual(30_000)
      // The row id travels on the chunk so live clients can update in place.
      expect(warning!.stall!.messageId).toBe(persistedOnWarn[0]!.id)

      push({ type: 'text', text: 'back' })
      await vi.advanceTimersByTimeAsync(1)

      const [, resolved] = stallChunks(events)
      expect(resolved?.type).toBe('stall_resolved')
      expect(resolved!.stall).toMatchObject({
        messageId: persistedOnWarn[0]!.id,
        startedAt: warning!.stall!.startedAt,
        outcome: 'recovered',
      })
      expect(resolved!.stall!.resolvedAt).toBeDefined()

      // Updated, not duplicated and not deleted.
      const persistedOnResolve = stallRows(db)
      expect(persistedOnResolve).toHaveLength(1)
      expect(persistedOnResolve[0]!.id).toBe(persistedOnWarn[0]!.id)
      expect(persistedOnResolve[0]!.metadata.outcome).toBe('recovered')
      expect(persistedOnResolve[0]!.metadata.durationMs).toBeGreaterThanOrEqual(31_000)
      expect(persistedOnResolve[0]!.content).toContain('Provider recovered')

      push({ type: 'done' })
      finish()
      await vi.advanceTimersByTimeAsync(1)
      expect(runner.hasActiveTurn(USER_ID)).toBe(false)
    })

    it('finalizes the stall row as aborted when the abort threshold is reached', async () => {
      vi.useFakeTimers()
      const db = freshDb()
      const { agent } = controllableAgent()
      const runner = startRunner(db, agent, {
        stallWarnMs: 30_000,
        stallAbortMs: 90_000,
        watchdogIntervalMs: 1_000,
      })

      const events: TurnEvent[] = []
      runner.subscribe(USER_ID, collect(events))
      runner.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'hi' })
      await vi.advanceTimersByTimeAsync(0)

      await vi.advanceTimersByTimeAsync(31_000)
      expect(stallChunks(events).map(c => c.type)).toEqual(['stall_warning'])

      await vi.advanceTimersByTimeAsync(60_000)
      expect(chunkTypes(events)).toEqual(['stall_warning', 'stall_resolved', 'error', 'done'])

      const [, resolved] = stallChunks(events)
      expect(resolved!.stall!.outcome).toBe('aborted')
      expect(resolved!.stall!.durationMs).toBeGreaterThanOrEqual(90_000)

      const errorChunk = events.find(e => e.type === 'chunk' && e.chunk.type === 'error') as { chunk: ResponseChunk }
      expect(errorChunk.chunk.error).toContain('Provider stopped responding')
      expect(agent.abort).toHaveBeenCalled()

      const persisted = stallRows(db)
      expect(persisted).toHaveLength(1)
      expect(persisted[0]!.metadata.outcome).toBe('aborted')
      expect(persisted[0]!.metadata.resolvedAt).not.toBeNull()
      expect(persisted[0]!.content).toContain('Provider stopped responding')
    })

    it('takes warn/abort thresholds from the settings file when not overridden', async () => {
      useSettingsFile({ watchdog: { stallWarnMs: 5_000, stallAbortMs: 12_000 } })
      vi.useFakeTimers()

      const db = freshDb()
      const { agent } = controllableAgent()
      const runner = startRunner(db, agent, { watchdogIntervalMs: 1_000 })

      const events: TurnEvent[] = []
      runner.subscribe(USER_ID, collect(events))
      runner.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'hi' })
      await vi.advanceTimersByTimeAsync(0)

      await vi.advanceTimersByTimeAsync(4_000)
      expect(stallChunks(events)).toEqual([])

      await vi.advanceTimersByTimeAsync(2_000)
      expect(stallChunks(events).map(c => c.type)).toEqual(['stall_warning'])

      await vi.advanceTimersByTimeAsync(7_000)
      expect(stallChunks(events).map(c => c.type)).toEqual(['stall_warning', 'stall_resolved'])
      expect(stallRows(db)[0]!.metadata.outcome).toBe('aborted')
    })
  })

  it('surfaces a missing agent as an error instead of hanging', async () => {
    const db = freshDb()
    const runner = startRunner(db, null)

    const events: TurnEvent[] = []
    runner.subscribe(USER_ID, collect(events))
    runner.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'hi' })
    await waitFor(() => !runner.hasActiveTurn(USER_ID))

    expect(chunkTypes(events)).toEqual(['error', 'done'])
  })
})
