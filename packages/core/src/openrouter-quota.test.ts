import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fetchOpenRouterQuota,
  getOpenRouterQuotaForProvider,
  isOpenRouterQuotaProvider,
  parseOpenRouterBalance,
} from './openrouter-quota.js'
import type { ProviderConfig } from './provider-config.js'

function mockResponse(init: {
  ok: boolean
  status: number
  json?: unknown
  headers?: Record<string, string>
}): Response {
  return {
    ok: init.ok,
    status: init.status,
    headers: { get: (name: string) => init.headers?.[name.toLowerCase()] ?? null },
    json: async () => init.json ?? {},
  } as unknown as Response
}

type MockInit = Parameters<typeof mockResponse>[0]

function routedFetch(routes: { key: MockInit | Error; credits: MockInit | Error }) {
  return vi.fn(async (url: string) => {
    const route = url.endsWith('/credits') ? routes.credits : routes.key
    if (route instanceof Error) throw route
    return mockResponse(route)
  })
}

const provider: ProviderConfig = {
  id: 'openrouter-1',
  name: 'OpenRouter',
  type: 'openai-completions',
  providerType: 'openrouter',
  provider: 'openrouter',
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKey: 'sk-or-test',
  enabledModels: ['qwen/qwen3.8-flash'],
  authMethod: 'api-key',
}

const keyResponse = {
  data: {
    label: 'sk-or-v1-abc...123',
    is_management_key: false,
    limit: 5,
    limit_reset: 'weekly',
    limit_remaining: 4.9999909,
    include_byok_in_limit: false,
    usage: 0.672371854,
    usage_daily: 0.0000091,
    usage_weekly: 0.0000091,
    usage_monthly: 0.25,
    is_free_tier: false,
  },
}

const unlimitedKeyResponse = {
  data: { ...keyResponse.data, limit: null, limit_reset: null, limit_remaining: null },
}

const creditsResponse = { data: { total_credits: 20, total_usage: 6.5 } }

const now = new Date('2026-09-13T21:00:00.000Z')

describe('isOpenRouterQuotaProvider', () => {
  it('matches an OpenRouter provider with an API key', () => {
    expect(isOpenRouterQuotaProvider(provider)).toBe(true)
  })

  it('does not match an OpenRouter provider without an API key', () => {
    expect(isOpenRouterQuotaProvider({ ...provider, apiKey: '' })).toBe(false)
  })

  it('does not match other providers', () => {
    expect(isOpenRouterQuotaProvider({ ...provider, providerType: 'openai' })).toBe(false)
  })
})

describe('parseOpenRouterBalance', () => {
  it('caps the account balance by the key credit limit', () => {
    expect(parseOpenRouterBalance(keyResponse, creditsResponse, now)).toEqual({
      currency: 'USD',
      total: 13.5,
      reserved: 0,
      available: 4.9999909,
      periodSpent: 0.25,
      periodEndsAt: '2026-10-01T00:00:00.000Z',
    })
  })

  it('uses the account balance when the key has no credit limit', () => {
    expect(parseOpenRouterBalance(unlimitedKeyResponse, creditsResponse, now)).toMatchObject({
      total: 13.5,
      available: 13.5,
    })
  })

  it('uses the account balance when it is lower than the key limit', () => {
    expect(parseOpenRouterBalance(keyResponse, { data: { total_credits: 10, total_usage: 8 } }, now)).toMatchObject({
      total: 2,
      available: 2,
    })
  })

  it('falls back to the key credit limit without account data', () => {
    expect(parseOpenRouterBalance(keyResponse, null, now)).toMatchObject({
      total: 4.9999909,
      available: 4.9999909,
    })
  })

  it('returns null for an unlimited key without account data', () => {
    expect(parseOpenRouterBalance(unlimitedKeyResponse, null, now)).toBeNull()
  })

  it('ignores incomplete account data', () => {
    expect(parseOpenRouterBalance(unlimitedKeyResponse, { data: { total_credits: 20 } }, now)).toBeNull()
  })

  it('clamps a negative account balance at zero available', () => {
    expect(parseOpenRouterBalance(unlimitedKeyResponse, { data: { total_credits: 1, total_usage: 1.5 } }, now)).toMatchObject({
      total: -0.5,
      available: 0,
    })
  })

  it('omits the period when monthly usage is missing', () => {
    expect(parseOpenRouterBalance({ data: { limit_remaining: 3 } }, null, now)).toMatchObject({
      available: 3,
      periodSpent: null,
      periodEndsAt: null,
    })
  })
})

describe('fetchOpenRouterQuota', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('queries /key and /credits with the bearer key and returns a balance-only snapshot', async () => {
    const fetchImpl = routedFetch({
      key: { ok: true, status: 200, json: keyResponse },
      credits: { ok: true, status: 200, json: creditsResponse },
    })

    const result = await fetchOpenRouterQuota('sk-or-test', fetchImpl as unknown as typeof fetch)

    expect(fetchImpl).toHaveBeenCalledWith('https://openrouter.ai/api/v1/key', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer sk-or-test' }),
    }))
    expect(fetchImpl).toHaveBeenCalledWith('https://openrouter.ai/api/v1/credits', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer sk-or-test' }),
    }))
    expect(result.status).toBe(200)
    expect(result.quota).toEqual({
      kind: 'openrouter',
      windows: [],
      balance: {
        currency: 'USD',
        total: 13.5,
        reserved: 0,
        available: 4.9999909,
        periodSpent: 0.25,
        periodEndsAt: '2026-10-01T00:00:00.000Z',
      },
      fetchedAt: '2026-09-13T21:00:00.000Z',
    })
  })

  it('falls back to the key limit when /credits is forbidden', async () => {
    const fetchImpl = routedFetch({
      key: { ok: true, status: 200, json: keyResponse },
      credits: { ok: false, status: 403 },
    })

    const result = await fetchOpenRouterQuota('sk-or-test', fetchImpl as unknown as typeof fetch)

    expect(result.quota?.balance).toMatchObject({ total: 4.9999909, available: 4.9999909 })
  })

  it('reports an unlimited key whose account balance is not readable', async () => {
    const fetchImpl = routedFetch({
      key: { ok: true, status: 200, json: unlimitedKeyResponse },
      credits: { ok: false, status: 403 },
    })

    const result = await fetchOpenRouterQuota('sk-or-test', fetchImpl as unknown as typeof fetch)

    expect(result.quota).toBeNull()
    expect(result.status).toBe(403)
    expect(result.error).toMatch(/no usable balance/)
  })

  it('surfaces /key HTTP errors with retry-after', async () => {
    const fetchImpl = routedFetch({
      key: { ok: false, status: 429, headers: { 'retry-after': '30' } },
      credits: { ok: true, status: 200, json: creditsResponse },
    })

    const result = await fetchOpenRouterQuota('sk-or-test', fetchImpl as unknown as typeof fetch)

    expect(result).toEqual({ quota: null, status: 429, retryAfterMs: 30_000, error: 'HTTP 429' })
  })

  it('reports network errors', async () => {
    const fetchImpl = routedFetch({ key: new Error('boom'), credits: new Error('boom') })

    const result = await fetchOpenRouterQuota('sk-or-test', fetchImpl as unknown as typeof fetch)

    expect(result).toEqual({ quota: null, status: undefined, retryAfterMs: undefined, error: 'boom' })
  })
})

describe('getOpenRouterQuotaForProvider', () => {
  it('rejects non-OpenRouter providers', async () => {
    const result = await getOpenRouterQuotaForProvider({ ...provider, providerType: 'openai' })
    expect(result.quota).toBeNull()
    expect(result.error).toMatch(/not an OpenRouter provider/)
  })

  it('uses the provider API key as bearer credential', async () => {
    const fetchImpl = routedFetch({
      key: { ok: true, status: 200, json: keyResponse },
      credits: { ok: true, status: 200, json: creditsResponse },
    })

    const result = await getOpenRouterQuotaForProvider(provider, fetchImpl as unknown as typeof fetch)

    expect(fetchImpl).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer sk-or-test' }),
    }))
    expect(result.quota?.balance?.available).toBe(4.9999909)
  })
})
