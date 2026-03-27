import { describe, it, expect, afterEach } from 'vitest'
import { initDatabase } from './database.js'
import { logTokenUsage, logToolCall, getTokenUsage, getToolCalls } from './token-logger.js'
import type { Database } from './database.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

describe('token-logger', () => {
  const tmpFiles: string[] = []
  let db: Database

  afterEach(() => {
    if (db) {
      try { db.close() } catch { /* ignore */ }
    }
    for (const f of tmpFiles) {
      try { fs.unlinkSync(f) } catch { /* ignore */ }
    }
    tmpFiles.length = 0
  })

  function createDb(): Database {
    const p = path.join(os.tmpdir(), `openagent-token-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
    tmpFiles.push(p)
    db = initDatabase(p)
    return db
  }

  describe('logTokenUsage', () => {
    it('inserts token usage record', () => {
      const testDb = createDb()

      logTokenUsage(testDb, {
        provider: 'openai',
        model: 'gpt-4o',
        promptTokens: 150,
        completionTokens: 75,
        estimatedCost: 0.001125,
        sessionId: 'session-123',
      })

      const rows = testDb.prepare('SELECT * FROM token_usage').all() as Record<string, unknown>[]
      expect(rows).toHaveLength(1)
      expect(rows[0].provider).toBe('openai')
      expect(rows[0].model).toBe('gpt-4o')
      expect(rows[0].prompt_tokens).toBe(150)
      expect(rows[0].completion_tokens).toBe(75)
      expect(rows[0].estimated_cost).toBeCloseTo(0.001125)
      expect(rows[0].session_id).toBe('session-123')
    })

    it('inserts without session_id', () => {
      const testDb = createDb()

      logTokenUsage(testDb, {
        provider: 'anthropic',
        model: 'claude-3-5-sonnet-20241022',
        promptTokens: 200,
        completionTokens: 100,
        estimatedCost: 0.002,
      })

      const rows = testDb.prepare('SELECT * FROM token_usage').all() as Record<string, unknown>[]
      expect(rows).toHaveLength(1)
      expect(rows[0].session_id).toBeNull()
    })
  })

  describe('logToolCall', () => {
    it('inserts tool call record', () => {
      const testDb = createDb()

      logToolCall(testDb, {
        sessionId: 'session-456',
        toolName: 'shell',
        input: '{"command": "ls -la"}',
        output: '{"exitCode": 0}',
        durationMs: 250,
      })

      const rows = testDb.prepare('SELECT * FROM tool_calls').all() as Record<string, unknown>[]
      expect(rows).toHaveLength(1)
      expect(rows[0].session_id).toBe('session-456')
      expect(rows[0].tool_name).toBe('shell')
      expect(rows[0].input).toBe('{"command": "ls -la"}')
      expect(rows[0].duration_ms).toBe(250)
    })
  })

  describe('getTokenUsage', () => {
    it('returns all records when no filters', () => {
      const testDb = createDb()

      logTokenUsage(testDb, { provider: 'openai', model: 'gpt-4o', promptTokens: 100, completionTokens: 50, estimatedCost: 0.001 })
      logTokenUsage(testDb, { provider: 'anthropic', model: 'claude-3-5-sonnet-20241022', promptTokens: 200, completionTokens: 100, estimatedCost: 0.002 })

      const records = getTokenUsage(testDb)
      expect(records).toHaveLength(2)
    })

    it('filters by provider', () => {
      const testDb = createDb()

      logTokenUsage(testDb, { provider: 'openai', model: 'gpt-4o', promptTokens: 100, completionTokens: 50, estimatedCost: 0.001 })
      logTokenUsage(testDb, { provider: 'anthropic', model: 'claude-3-5-sonnet-20241022', promptTokens: 200, completionTokens: 100, estimatedCost: 0.002 })

      const records = getTokenUsage(testDb, { provider: 'openai' })
      expect(records).toHaveLength(1)
      expect(records[0].provider).toBe('openai')
    })

    it('filters by model', () => {
      const testDb = createDb()

      logTokenUsage(testDb, { provider: 'openai', model: 'gpt-4o', promptTokens: 100, completionTokens: 50, estimatedCost: 0.001 })
      logTokenUsage(testDb, { provider: 'openai', model: 'gpt-4o-mini', promptTokens: 50, completionTokens: 25, estimatedCost: 0.0001 })

      const records = getTokenUsage(testDb, { model: 'gpt-4o-mini' })
      expect(records).toHaveLength(1)
      expect(records[0].model).toBe('gpt-4o-mini')
    })

    it('respects limit', () => {
      const testDb = createDb()

      for (let i = 0; i < 5; i++) {
        logTokenUsage(testDb, { provider: 'openai', model: 'gpt-4o', promptTokens: 100, completionTokens: 50, estimatedCost: 0.001 })
      }

      const records = getTokenUsage(testDb, { limit: 3 })
      expect(records).toHaveLength(3)
    })
  })

  describe('getToolCalls', () => {
    it('returns all records when no filters', () => {
      const testDb = createDb()

      logToolCall(testDb, { sessionId: 's1', toolName: 'shell', input: '{}', output: '{}', durationMs: 100 })
      logToolCall(testDb, { sessionId: 's1', toolName: 'read_file', input: '{}', output: '{}', durationMs: 50 })

      const records = getToolCalls(testDb)
      expect(records).toHaveLength(2)
    })

    it('filters by sessionId', () => {
      const testDb = createDb()

      logToolCall(testDb, { sessionId: 's1', toolName: 'shell', input: '{}', output: '{}', durationMs: 100 })
      logToolCall(testDb, { sessionId: 's2', toolName: 'shell', input: '{}', output: '{}', durationMs: 100 })

      const records = getToolCalls(testDb, { sessionId: 's1' })
      expect(records).toHaveLength(1)
      expect(records[0].sessionId).toBe('s1')
    })

    it('filters by toolName', () => {
      const testDb = createDb()

      logToolCall(testDb, { sessionId: 's1', toolName: 'shell', input: '{}', output: '{}', durationMs: 100 })
      logToolCall(testDb, { sessionId: 's1', toolName: 'read_file', input: '{}', output: '{}', durationMs: 50 })

      const records = getToolCalls(testDb, { toolName: 'read_file' })
      expect(records).toHaveLength(1)
      expect(records[0].toolName).toBe('read_file')
    })

    it('respects limit', () => {
      const testDb = createDb()

      for (let i = 0; i < 5; i++) {
        logToolCall(testDb, { sessionId: 's1', toolName: 'shell', input: '{}', output: '{}', durationMs: 100 })
      }

      const records = getToolCalls(testDb, { limit: 2 })
      expect(records).toHaveLength(2)
    })
  })
})
