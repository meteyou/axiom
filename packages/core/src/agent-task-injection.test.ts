import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentCore } from './agent.js'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import type { ResponseChunk } from './agent-runtime-types.js'

const { streamPromptMock } = vi.hoisted(() => ({
  streamPromptMock: vi.fn(),
}))

vi.mock('./memory.js', () => ({
  ensureMemoryStructure: vi.fn(),
  ensureConfigStructure: vi.fn(),
  assembleSystemPrompt: vi.fn(() => 'test system prompt'),
  appendToDailyFile: vi.fn(),
}))

vi.mock('./config.js', () => ({
  ensureConfigTemplates: vi.fn(),
  loadConfig: vi.fn(() => ({})),
  getConfigDir: vi.fn(() => '/tmp/test-config'),
}))

vi.mock('./agent-runtime.js', () => ({
  createAgentRuntime: vi.fn(() => ({
    streamPrompt: streamPromptMock,
    refreshSystemPrompt: vi.fn(),
    getCurrentTimeContext: vi.fn(() => '<current_time>Current time: 12:00 (UTC)</current_time>'),
    swapProvider: vi.fn(),
    getProviderManager: vi.fn(() => undefined),
    clearMessages: vi.fn(),
    abort: vi.fn(),
    getStateSnapshot: vi.fn(() => ({
      modelId: 'mock-model',
      toolNames: [],
      messageCount: 0,
    })),
    getCurrentModel: vi.fn(() => ({ id: 'mock-model' })),
    getCurrentApiKey: vi.fn(() => 'mock-key'),
    setThinkingLevel: vi.fn(),
  })),
  createYoloTools: vi.fn(() => []),
  isRetryablePreStreamError: vi.fn(() => false),
}))

function makeModel() {
  return {
    id: 'gpt-4o',
    name: 'GPT-4o',
    api: 'openai-completions' as const,
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    reasoning: false,
    input: ['text' as const, 'image' as const],
    cost: { input: 2.5, output: 10, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
  }
}

describe('AgentCore task injection chunk metadata', () => {
  let db: Database

  beforeEach(() => {
    db = initDatabase(':memory:')
    streamPromptMock.mockReset()
    streamPromptMock.mockImplementation(async function* () {
      yield { type: 'text', text: 'injection response' }
      yield { type: 'done' }
    })
  })

  it('includes the actual sessionId on task injection chunks', async () => {
    const agent = new AgentCore({
      model: makeModel(),
      apiKey: 'sk-test',
      db,
      tools: [],
    })

    const chunks: ResponseChunk[] = []
    agent.setOnTaskInjectionChunk((chunk) => {
      chunks.push(chunk)
    })

    await agent.injectTaskResult('<task_injection>done</task_injection>', '1')

    expect(streamPromptMock).toHaveBeenCalledTimes(1)
    const usedSessionId = streamPromptMock.mock.calls[0][1] as string

    expect(usedSessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks.every(chunk => chunk.sessionId === usedSessionId)).toBe(true)

    await agent.dispose()
    db.close()
  })

  it('honors a forced sessionId so chunks always report the caller-pinned id', async () => {
    // Guards the correlation contract used by runtime-composition: the
    // caller pre-resolves a session id, pins it via the third argument,
    // and every emitted chunk carries that session id.
    const agent = new AgentCore({
      model: makeModel(),
      apiKey: 'sk-test',
      db,
      tools: [],
    })

    const forcedSessionId = '11111111-2222-3333-4444-555555555555'
    const chunks: ResponseChunk[] = []
    agent.setOnTaskInjectionChunk((chunk) => {
      chunks.push(chunk)
    })

    await agent.injectTaskResult('<task_injection>done</task_injection>', '1', forcedSessionId)

    expect(streamPromptMock).toHaveBeenCalledTimes(1)
    expect(streamPromptMock.mock.calls[0][1]).toBe(forcedSessionId)
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks.every(chunk => chunk.sessionId === forcedSessionId)).toBe(true)

    await agent.dispose()
    db.close()
  })

  it('tags every chunk with a caller-supplied injectionId for per-call correlation', async () => {
    // Regression guard: concurrent task completions for the same user
    // resolve to the same cached session id, so the chunk handler MUST
    // correlate via `chunk.injectionId` (unique per call) instead of
    // `chunk.sessionId` (shared). This verifies the id is propagated
    // verbatim onto every emitted chunk.
    const agent = new AgentCore({
      model: makeModel(),
      apiKey: 'sk-test',
      db,
      tools: [],
    })

    const injectionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const chunks: ResponseChunk[] = []
    agent.setOnTaskInjectionChunk((chunk) => {
      chunks.push(chunk)
    })

    await agent.injectTaskResult(
      '<task_injection>done</task_injection>',
      '1',
      undefined,
      injectionId,
    )

    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks.every(chunk => chunk.injectionId === injectionId)).toBe(true)

    await agent.dispose()
    db.close()
  })

  it('mints a fresh injectionId when the caller does not supply one', async () => {
    // When no injectionId is supplied, AgentCore generates one so every
    // call still has a unique correlation token (needed for callers that
    // don't yet pre-register metadata).
    const agent = new AgentCore({
      model: makeModel(),
      apiKey: 'sk-test',
      db,
      tools: [],
    })

    const chunks: ResponseChunk[] = []
    agent.setOnTaskInjectionChunk((chunk) => {
      chunks.push(chunk)
    })

    await agent.injectTaskResult('<task_injection>done</task_injection>', '1')

    expect(chunks.length).toBeGreaterThan(0)
    const ids = new Set(chunks.map(c => c.injectionId))
    expect(ids.size).toBe(1)
    const [onlyId] = ids
    expect(onlyId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)

    await agent.dispose()
    db.close()
  })

  it('resolveInjectionSessionId returns cached session id when user has active session', async () => {
    const agent = new AgentCore({
      model: makeModel(),
      apiKey: 'sk-test',
      db,
      tools: [],
    })
    const cached = agent.getSessionManager().getOrCreateSession('1', 'web')
    expect(agent.resolveInjectionSessionId('1', null)).toBe(cached.id)
    // Fallback is ignored when cached session exists.
    expect(agent.resolveInjectionSessionId('1', 'some-lineage-id')).toBe(cached.id)
    await agent.dispose()
    db.close()
  })

  it('resolveInjectionSessionId falls back to provided lineage id when no cached session', async () => {
    const agent = new AgentCore({
      model: makeModel(),
      apiKey: 'sk-test',
      db,
      tools: [],
    })
    // Different user with no cached session — lineage id is used without
    // minting a new interactive session, preserving continuity with the
    // task's triggering session.
    const lineageId = 'linage-sess-id'
    expect(agent.resolveInjectionSessionId('99', lineageId)).toBe(lineageId)
    // And no session row is created for that user.
    const rows = db.prepare("SELECT id FROM sessions WHERE session_user = '99'").all()
    expect(rows).toHaveLength(0)
    await agent.dispose()
    db.close()
  })

  it('resolveInjectionSessionId prefers telegram source when user is linked to approved telegram account', async () => {
    // Creates a user + approved telegram_users row; with no cached session
    // and no lineage fallback, the helper should mint a session with
    // source='telegram' so future Telegram traffic is correctly tagged.
    db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (7, 'bob', 'h', 'user')").run()
    db.prepare("INSERT INTO telegram_users (telegram_id, status, user_id) VALUES ('tg-42', 'approved', 7)").run()

    const agent = new AgentCore({
      model: makeModel(),
      apiKey: 'sk-test',
      db,
      tools: [],
    })
    const sessionId = agent.resolveInjectionSessionId('7', null)
    const row = db.prepare('SELECT source, type FROM sessions WHERE id = ?').get(sessionId) as {
      source: string
      type: string
    }
    expect(row.source).toBe('telegram')
    expect(row.type).toBe('interactive')
    await agent.dispose()
    db.close()
  })
})
