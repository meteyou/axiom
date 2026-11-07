import { describe, expect, it, vi } from 'vitest'
import type { Api, Model } from '@earendil-works/pi-ai'
import { initDatabase } from '@axiom/core'
import type { Database, IncrementalFactExtractionResult, ProviderConfig } from '@axiom/core'
import {
  resolveFactExtractionExecutionContext,
  triggerFactExtraction,
} from './fact-extraction-trigger.js'

function insertSession(db: Database, input: { id: string; userId: number; messageCount: number }): void {
  db.prepare(
    `INSERT INTO sessions (id, user_id, source, started_at, ended_at, message_count, summary_written)
     VALUES (?, ?, 'web', datetime('now', '-5 minutes'), datetime('now'), ?, 1)`
  ).run(input.id, input.userId, input.messageCount)
}

function makeProvider(id: string, name: string): ProviderConfig {
  return {
    id,
    name,
    type: 'openai-completions',
    providerType: 'openai',
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-test',
    enabledModels: ['gpt-4o-mini'],
    status: 'connected',
    authMethod: 'api-key',
  }
}

function makeModel(id = 'gpt-4o-mini'): Model<Api> {
  return {
    id,
    name: id,
    api: 'openai-completions',
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    reasoning: false,
    input: ['text'],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 128000,
    maxTokens: 16384,
  }
}

function makeResult(overrides: Partial<IncrementalFactExtractionResult> = {}): IncrementalFactExtractionResult {
  return { chunks: 1, extracted: 1, stored: 1, duplicates: 0, superseded: 0, ...overrides }
}

describe('fact-extraction trigger', () => {
  it('resolves a dedicated provider first and falls back to the active provider', async () => {
    const dedicatedProvider = makeProvider('dedicated', 'Dedicated')
    const activeProvider = makeProvider('active', 'Active')
    const buildModel = vi.fn((provider: ProviderConfig) => makeModel(provider.enabledModels?.[0]))
    const getApiKeyForProvider = vi.fn().mockResolvedValue('resolved-key')

    const dedicatedContext = await resolveFactExtractionExecutionContext(
      { enabled: true, providerId: 'dedicated', minSessionMessages: 3 },
      {
        loadProvidersDecrypted: () => ({ providers: [dedicatedProvider] }),
        getActiveProvider: () => activeProvider,
        buildModel,
        getApiKeyForProvider,
        console: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
      },
    )

    expect(dedicatedContext).not.toBeNull()
    expect(buildModel).toHaveBeenCalledWith(dedicatedProvider, 'gpt-4o-mini')
    expect(getApiKeyForProvider).toHaveBeenCalledWith(dedicatedProvider)

    buildModel.mockClear()
    getApiKeyForProvider.mockClear()

    const fallbackContext = await resolveFactExtractionExecutionContext(
      { enabled: true, providerId: '', minSessionMessages: 3 },
      {
        loadProvidersDecrypted: () => ({ providers: [dedicatedProvider] }),
        getActiveProvider: () => activeProvider,
        buildModel,
        getApiKeyForProvider,
        console: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
      },
    )

    expect(fallbackContext).not.toBeNull()
    expect(buildModel).toHaveBeenCalledWith(activeProvider, 'gpt-4o-mini')
    expect(getApiKeyForProvider).toHaveBeenCalledWith(activeProvider)
  })

  it('skips fact extraction when disabled or below the minimum message threshold', async () => {
    const db = initDatabase(':memory:')
    db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (1, ?, ?, ?)').run('alice', 'hash', 'user')
    insertSession(db, { id: 'session-1', userId: 1, messageCount: 2 })

    const extractFactsIncrementally = vi.fn().mockResolvedValue(makeResult())

    expect(triggerFactExtraction({
      db,
      userId: '1',
      sessionId: 'session-1',
      trigger: 'session_end',
      deps: {
        loadSettings: () => ({ factExtraction: { enabled: false, providerId: '', minSessionMessages: 3 } }),
        extractFactsIncrementally,
      },
    })).toBe(false)

    expect(triggerFactExtraction({
      db,
      userId: '1',
      sessionId: 'session-1',
      trigger: 'compaction',
      deps: {
        loadSettings: () => ({ factExtraction: { enabled: true, providerId: '', minSessionMessages: 3 } }),
        extractFactsIncrementally,
      },
    })).toBe(false)

    await Promise.resolve()
    expect(extractFactsIncrementally).not.toHaveBeenCalled()
    db.close()
  })

  it('skips fact extraction when the session has no numeric user scope', async () => {
    const db = initDatabase(':memory:')
    db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (1, ?, ?, ?)').run('alice', 'hash', 'user')
    insertSession(db, { id: 'session-guest', userId: 1, messageCount: 4 })
    db.prepare(
      'UPDATE sessions SET user_id = NULL, session_user = ? WHERE id = ?'
    ).run('telegram-123', 'session-guest')

    const extractFactsIncrementally = vi.fn().mockResolvedValue(makeResult())
    const warn = vi.fn()

    const triggered = triggerFactExtraction({
      db,
      userId: 'telegram-123',
      sessionId: 'session-guest',
      trigger: 'session_end',
      deps: {
        loadSettings: () => ({ factExtraction: { enabled: true, providerId: '', minSessionMessages: 3 } }),
        extractFactsIncrementally,
        console: { log: vi.fn(), warn, error: vi.fn() },
      },
    })

    expect(triggered).toBe(false)
    expect(extractFactsIncrementally).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith('[fact-extraction] Skipping session session-guest: no numeric user ID available')

    db.close()
  })

  it('runs the incremental extraction in the background and logs the result', async () => {
    const db = initDatabase(':memory:')
    db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (1, ?, ?, ?)').run('alice', 'hash', 'user')
    insertSession(db, { id: 'session-3', userId: 1, messageCount: 40 })

    const extractFactsIncrementally = vi.fn().mockResolvedValue(makeResult({ chunks: 3, stored: 5, superseded: 1 }))
    const log = vi.fn()

    const triggered = triggerFactExtraction({
      db,
      userId: '1',
      sessionId: 'session-3',
      trigger: 'compaction',
      deps: {
        loadSettings: () => ({ factExtraction: { enabled: true, providerId: '', minSessionMessages: 3 } }),
        getActiveProvider: () => makeProvider('active', 'Active'),
        buildModel: vi.fn(() => makeModel('gpt-4o-mini')),
        getApiKeyForProvider: vi.fn().mockResolvedValue('key'),
        extractFactsIncrementally,
        console: { log, warn: vi.fn(), error: vi.fn() },
      },
    })

    expect(triggered).toBe(true)
    await vi.waitFor(() => {
      expect(extractFactsIncrementally).toHaveBeenCalledWith({
        db,
        userId: 1,
        sessionId: 'session-3',
        model: expect.objectContaining({ id: 'gpt-4o-mini' }),
        apiKey: 'key',
      })
      expect(log).toHaveBeenCalledWith('[fact-extraction] Session session-3 (compaction): 3 chunk(s), 5 new facts, 1 superseded')
    })

    db.close()
  })

  it('fires-and-forgets extraction after session end and catches failures', async () => {
    const db = initDatabase(':memory:')
    db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (1, ?, ?, ?)').run('alice', 'hash', 'user')
    insertSession(db, { id: 'session-2', userId: 1, messageCount: 4 })

    const extractFactsIncrementally = vi.fn().mockRejectedValue(new Error('boom'))
    const log = vi.fn()
    const error = vi.fn()

    const triggered = triggerFactExtraction({
      db,
      userId: '1',
      sessionId: 'session-2',
      trigger: 'session_end',
      deps: {
        loadSettings: () => ({ factExtraction: { enabled: true, providerId: '', minSessionMessages: 3 } }),
        getActiveProvider: () => makeProvider('active', 'Active'),
        buildModel: vi.fn(() => makeModel('gpt-4o-mini')),
        getApiKeyForProvider: vi.fn().mockResolvedValue('key'),
        extractFactsIncrementally,
        console: { log, warn: vi.fn(), error },
      },
    })

    expect(triggered).toBe(true)
    expect(extractFactsIncrementally).not.toHaveBeenCalled()

    await vi.waitFor(() => {
      expect(extractFactsIncrementally).toHaveBeenCalledOnce()
      expect(error).toHaveBeenCalled()
    })

    expect(log).not.toHaveBeenCalled()
    expect(String(error.mock.calls[0][0])).toContain('[fact-extraction] Failed for session session-2 (session_end):')

    db.close()
  })
})
