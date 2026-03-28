import { describe, it, expect } from 'vitest'
import {
  performProviderHealthCheck,
  logHealthCheck,
  queryHealthCheckHistory,
  getLatestHealthCheck,
  getActivitySummary,
  initDatabase,
} from './index.js'

const provider = {
  id: 'provider-1',
  name: 'Test Provider',
  type: 'openai-completions',
  providerType: 'openai' as const,
  provider: 'openai',
  baseUrl: 'https://example.com/v1',
  apiKey: 'sk-test',
  defaultModel: 'gpt-4o-mini',
}

describe('provider-health', () => {
  it('returns unconfigured when no provider is active', async () => {
    const result = await performProviderHealthCheck(null)
    expect(result.status).toBe('unconfigured')
    expect(result.errorMessage).toContain('No active provider')
    expect(result.providerName).toBeNull()
    expect(result.isRateLimited).toBe(false)
  })

  it('classifies successful checks as healthy or degraded based on latency', async () => {
    const healthy = await performProviderHealthCheck(provider, {
      degradedThresholdMs: 100,
      fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    })
    expect(healthy.status).toBe('healthy')
    expect(healthy.errorMessage).toBeNull()
    expect(healthy.isRateLimited).toBe(false)

    const degraded = await performProviderHealthCheck(provider, {
      degradedThresholdMs: 1,
      fetchImpl: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      },
    })
    expect(degraded.status).toBe('degraded')
    expect(degraded.latencyMs).toBeGreaterThanOrEqual(1)
    expect(degraded.isRateLimited).toBe(false)
  })

  it('detects HTTP 429 and sets isRateLimited to true', async () => {
    const result = await performProviderHealthCheck(provider, {
      fetchImpl: async () => new Response(JSON.stringify({ error: 'Rate limit exceeded' }), { status: 429 }),
    })
    expect(result.status).toBe('down')
    expect(result.isRateLimited).toBe(true)
  })

  it('sets isRateLimited to false for non-429 errors', async () => {
    const result = await performProviderHealthCheck(provider, {
      fetchImpl: async () => new Response(JSON.stringify({ error: 'Server error' }), { status: 500 }),
    })
    expect(result.status).toBe('down')
    expect(result.isRateLimited).toBe(false)
  })

  it('logs history rows and activity summary in sqlite', () => {
    const db = initDatabase(':memory:')

    logHealthCheck(db, {
      timestamp: '2026-03-27T09:00:00.000Z',
      provider: 'OpenAI Primary',
      status: 'healthy',
      latencyMs: 240,
      errorMessage: null,
    })
    logHealthCheck(db, {
      timestamp: '2026-03-27T09:05:00.000Z',
      provider: 'OpenAI Primary',
      status: 'down',
      latencyMs: 15000,
      errorMessage: 'Connection timed out',
    })

    db.prepare(
      `INSERT INTO sessions (id, source, started_at, message_count, summary_written)
       VALUES (?, ?, datetime('now'), ?, ?)`
    ).run('session-1', 'web', 2, 0)
    db.prepare(
      `INSERT INTO chat_messages (session_id, role, content, timestamp)
       VALUES (?, ?, ?, datetime('now'))`
    ).run('session-1', 'user', 'Hello')
    db.prepare(
      `INSERT INTO chat_messages (session_id, role, content, timestamp)
       VALUES (?, ?, ?, datetime('now'))`
    ).run('session-1', 'assistant', 'Hi')

    const latest = getLatestHealthCheck(db)
    expect(latest?.status).toBe('down')
    expect(latest?.errorMessage).toBe('Connection timed out')

    const history = queryHealthCheckHistory(db, 1, 10)
    expect(history.records).toHaveLength(2)
    expect(history.records[0].status).toBe('down')
    expect(history.pagination.total).toBe(2)

    const activity = getActivitySummary(db)
    expect(activity.messagesToday).toBe(2)
    expect(activity.sessionsToday).toBe(1)

    db.close()
  })
})
