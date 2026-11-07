import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./pi-models.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>
  return {
    ...original,
    completeSimple: vi.fn(),
  }
})

import { completeSimple } from './pi-models.js'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import {
  buildPendingTranscriptChunks,
  extractFactsIncrementally,
  FACT_EXTRACTION_CHUNK_CHARS,
} from './incremental-fact-extraction.js'
import { getFactExtractionCursor } from './fact-extraction-cursor-store.js'
import { listMemories } from './memories-store.js'

const mockCompleteSimple = vi.mocked(completeSimple)

const model = {
  id: 'gpt-4o-mini',
  name: 'GPT-4o mini',
  api: 'openai-completions' as const,
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  reasoning: false,
  input: ['text' as const],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 16384,
}

function makeResponse(text: string) {
  return {
    role: 'assistant' as const,
    content: [{ type: 'text' as const, text }],
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    model: 'gpt-4o-mini',
    api: 'openai-completions' as const,
    provider: 'openai',
    stopReason: 'stop' as const,
    timestamp: Date.now(),
  }
}

type CompletionContext = Parameters<typeof completeSimple>[1]

function isExtractionCall(context: CompletionContext): boolean {
  return context.systemPrompt?.includes('fact extraction assistant') ?? false
}

function transcriptOf(context: CompletionContext): string {
  const content = String(context.messages[0].content)
  return content.slice(content.indexOf('<transcript>'))
}

/** Stands in for the extraction model: every "remember <token>" in the transcript becomes one fact. */
function extractRememberedTokens(context: CompletionContext) {
  if (!isExtractionCall(context)) return makeResponse('')
  const tokens = Array.from(transcriptOf(context).matchAll(/remember (\w+)/g), match => match[1])
  return makeResponse(tokens.length > 0 ? tokens.map(token => `- Remembered ${token}`).join('\n') : 'NO_FACTS')
}

function extractionCalls(): CompletionContext[] {
  return mockCompleteSimple.mock.calls.map(call => call[1]).filter(isExtractionCall)
}

function insertSession(db: Database, id: string, parentId: string | null = null): void {
  db.prepare(
    "INSERT INTO sessions (id, user_id, source, type, parent_session_id) VALUES (?, 1, 'web', ?, ?)"
  ).run(id, parentId ? 'task' : 'interactive', parentId)
}

function insertMessage(db: Database, sessionId: string, role: string, content: string, metadata: string | null = null): number {
  return Number(db.prepare(
    'INSERT INTO chat_messages (session_id, user_id, role, content, metadata) VALUES (?, 1, ?, ?, ?)'
  ).run(sessionId, role, content, metadata).lastInsertRowid)
}

/** Appends user/assistant pairs of ~1250 chars each (at most 10 per chunk, the per-call fact limit); message `i` asks to remember `token<i>`. */
function insertLongConversation(db: Database, sessionId: string, from: number, count: number): number {
  let lastId = 0
  for (let index = from; index < from + count; index += 1) {
    insertMessage(db, sessionId, 'user', `Please remember token${index}. ${'x'.repeat(1100)}`)
    lastId = insertMessage(db, sessionId, 'assistant', `Noted token${index}. ${'y'.repeat(100)}`)
  }
  return lastId
}

function storedFacts(db: Database): string[] {
  return listMemories(db, { userId: 1, limit: 500 }).facts.map(fact => fact.content).sort()
}

describe('incremental fact extraction', () => {
  let db: Database

  beforeEach(() => {
    db = initDatabase(':memory:')
    db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1, 'alice', 'hash', 'user')").run()
    insertSession(db, 'session-1')
    mockCompleteSimple.mockReset()
    mockCompleteSimple.mockImplementation(async (_model, context) => extractRememberedTokens(context))
  })

  afterEach(() => {
    db.close()
  })

  describe('buildPendingTranscriptChunks', () => {
    it('splits a long session at message boundaries and covers every message once', () => {
      const lastId = insertLongConversation(db, 'session-1', 0, 30)

      const chunks = buildPendingTranscriptChunks(db, 'session-1', 0)

      expect(chunks.length).toBeGreaterThan(2)
      for (const chunk of chunks) {
        expect(chunk.text.length).toBeLessThanOrEqual(FACT_EXTRACTION_CHUNK_CHARS)
        expect(chunk.text.startsWith('User: ')).toBe(true)
      }
      expect(chunks.map(chunk => chunk.throughMessageId)).toEqual(
        [...chunks.map(chunk => chunk.throughMessageId)].sort((a, b) => a - b),
      )
      expect(chunks.at(-1)?.throughMessageId).toBe(lastId)

      const joined = chunks.map(chunk => chunk.text).join('\n')
      for (let index = 0; index < 30; index += 1) {
        expect(joined.match(new RegExp(`remember token${index}\\.`, 'g'))).toHaveLength(1)
      }
    })

    it('starts after the cursor and passes the processed tail as earlier context', () => {
      insertMessage(db, 'session-1', 'user', 'Earlier question about postgres')
      const cursor = insertMessage(db, 'session-1', 'assistant', 'Earlier answer about postgres')
      insertMessage(db, 'session-1', 'user', 'New question about redis')

      const [chunk, ...rest] = buildPendingTranscriptChunks(db, 'session-1', cursor)

      expect(rest).toEqual([])
      expect(chunk.text).toBe('User: New question about redis')
      expect(chunk.earlierContext).toBe('User: Earlier question about postgres\nAssistant: Earlier answer about postgres')
    })

    it('includes descendant task sessions, truncates oversized messages and moves past rows without a transcript line', () => {
      insertSession(db, 'task-1', 'session-1')
      insertMessage(db, 'session-1', 'user', 'z'.repeat(50))
      insertMessage(db, 'task-1', 'system', 'Task finished', JSON.stringify({ type: 'task_result', taskName: 'Build' }))
      const toolRowId = insertMessage(db, 'session-1', 'tool', 'tool output')

      const chunks = buildPendingTranscriptChunks(db, 'session-1', 0, 30)

      expect(chunks.map(chunk => chunk.text)).toEqual([
        `User: ${'z'.repeat(24)}`,
        'Background task (completed: Bu',
      ])
      expect(chunks.at(-1)?.throughMessageId).toBe(toolRowId)
    })

    it('returns no chunks when nothing new arrived', () => {
      const lastId = insertLongConversation(db, 'session-1', 0, 2)
      expect(buildPendingTranscriptChunks(db, 'session-1', lastId)).toEqual([])
    })
  })

  describe('extractFactsIncrementally', () => {
    it('extracts facts from the whole session, not only the first 12k chars', async () => {
      const lastId = insertLongConversation(db, 'session-1', 0, 30)

      const result = await extractFactsIncrementally({ db, userId: 1, sessionId: 'session-1', model, apiKey: 'key' })

      expect(result.chunks).toBeGreaterThan(2)
      expect(result.chunks).toBe(extractionCalls().length)
      expect(result.stored).toBe(30)
      expect(storedFacts(db)).toContain('Remembered token29')
      expect(getFactExtractionCursor(db, 'session-1')).toBe(lastId)
      expect(String(extractionCalls()[1].messages[0].content)).toContain('<earlier_context>')
    })

    it('does not extract a chunk twice when re-run, and only processes messages added since', async () => {
      insertLongConversation(db, 'session-1', 0, 15)
      await extractFactsIncrementally({ db, userId: 1, sessionId: 'session-1', model, apiKey: 'key' })
      const firstRunCalls = extractionCalls().length
      const factsAfterFirstRun = storedFacts(db)

      const rerun = await extractFactsIncrementally({ db, userId: 1, sessionId: 'session-1', model, apiKey: 'key' })

      expect(rerun).toEqual({ chunks: 0, extracted: 0, stored: 0, duplicates: 0, superseded: 0 })
      expect(extractionCalls()).toHaveLength(firstRunCalls)
      expect(storedFacts(db)).toEqual(factsAfterFirstRun)

      const lastId = insertLongConversation(db, 'session-1', 15, 1)
      const incremental = await extractFactsIncrementally({ db, userId: 1, sessionId: 'session-1', model, apiKey: 'key' })

      expect(incremental).toMatchObject({ chunks: 1, stored: 1 })
      const latestTranscript = transcriptOf(extractionCalls().at(-1)!)
      expect(latestTranscript).toContain('remember token15')
      expect(latestTranscript).not.toContain('remember token14')
      expect(storedFacts(db)).toHaveLength(16)
      expect(getFactExtractionCursor(db, 'session-1')).toBe(lastId)
    })

    it('keeps the cursor at the last stored chunk when a later chunk fails and resumes there', async () => {
      insertLongConversation(db, 'session-1', 0, 30)
      let extractionCount = 0
      mockCompleteSimple.mockImplementation(async (_model, context) => {
        if (isExtractionCall(context) && ++extractionCount === 2) throw new Error('provider down')
        return extractRememberedTokens(context)
      })

      await expect(extractFactsIncrementally({ db, userId: 1, sessionId: 'session-1', model, apiKey: 'key' }))
        .rejects.toThrow('provider down')

      const [firstChunk] = buildPendingTranscriptChunks(db, 'session-1', 0)
      expect(getFactExtractionCursor(db, 'session-1')).toBe(firstChunk.throughMessageId)
      const factsAfterFailure = storedFacts(db)
      expect(factsAfterFailure.length).toBeGreaterThan(0)
      expect(factsAfterFailure).not.toContain('Remembered token29')

      const resumed = await extractFactsIncrementally({ db, userId: 1, sessionId: 'session-1', model, apiKey: 'key' })

      expect(resumed.stored).toBe(30 - factsAfterFailure.length)
      expect(storedFacts(db)).toHaveLength(30)
    })

    it('serializes concurrent runs for the same session so no chunk is extracted twice', async () => {
      insertLongConversation(db, 'session-1', 0, 15)

      const [first, second] = await Promise.all([
        extractFactsIncrementally({ db, userId: 1, sessionId: 'session-1', model, apiKey: 'key' }),
        extractFactsIncrementally({ db, userId: 1, sessionId: 'session-1', model, apiKey: 'key' }),
      ])

      expect(first.chunks).toBeGreaterThan(0)
      expect(second.chunks).toBe(0)
      expect(storedFacts(db)).toHaveLength(15)
    })
  })
})
