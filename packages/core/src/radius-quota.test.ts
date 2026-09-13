import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchRadiusQuota, getRadiusQuotaForProvider, isRadiusQuotaProvider, parseRadiusBalance } from './radius-quota.js'
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

const apiKeyProvider: ProviderConfig = {
  id: 'radius-1',
  name: 'Radius',
  type: 'pi-messages',
  providerType: 'radius-api-key',
  provider: 'radius',
  baseUrl: 'https://radius.pi.dev/v1',
  apiKey: 'radius-org-key',
  enabledModels: ['kimi-k3'],
  authMethod: 'api-key',
}

const billingResponse = {
  ok: true,
  currency: 'USD',
  as_of: '2026-09-13T20:53:17.021Z',
  balance: { credit_balance: 9.99077183, reserved: 1.01676073, available: 8.9740111, updated_at: '2026-09-13T20:51:02.415Z' },
  current_period: { starts_at: '2026-09-01T00:00:00.000Z', ends_at: '2026-10-01T00:00:00.000Z', actual_charged: 0.00922817, actual_charge_count: 7 },
  all_time: { credited: 10, credit_count: 1, actual_charged: 0.00922817, actual_charge_count: 7 },
}

describe('isRadiusQuotaProvider', () => {
  it('matches an API-key Radius provider with a key', () => {
    expect(isRadiusQuotaProvider(apiKeyProvider)).toBe(true)
  })

  it('does not match an API-key Radius provider without a key', () => {
    expect(isRadiusQuotaProvider({ ...apiKeyProvider, apiKey: '' })).toBe(false)
  })

  it('matches an OAuth Radius provider with stored credentials', () => {
    expect(isRadiusQuotaProvider({
      ...apiKeyProvider,
      providerType: 'radius',
      apiKey: '',
      authMethod: 'oauth',
      oauthCredentials: { access: 'a', refresh: 'r', expires: Date.now() + 60_000 },
    })).toBe(true)
  })

  it('does not match non-Radius providers', () => {
    expect(isRadiusQuotaProvider({ ...apiKeyProvider, providerType: 'openrouter' })).toBe(false)
  })
})

describe('parseRadiusBalance', () => {
  it('maps the billing payload', () => {
    expect(parseRadiusBalance(billingResponse)).toEqual({
      currency: 'USD',
      total: 9.99077183,
      reserved: 1.01676073,
      available: 8.9740111,
      periodSpent: 0.00922817,
      periodEndsAt: '2026-10-01T00:00:00.000Z',
    })
  })

  it('derives available from total minus reserved when absent', () => {
    expect(parseRadiusBalance({ balance: { credit_balance: 10, reserved: 2 } })).toMatchObject({
      available: 8,
      currency: 'USD',
      periodSpent: null,
      periodEndsAt: null,
    })
  })

  it('clamps a derived available balance at zero', () => {
    expect(parseRadiusBalance({ balance: { credit_balance: 1, reserved: 3 } })?.available).toBe(0)
  })

  it('returns null without a credit balance', () => {
    expect(parseRadiusBalance({ ok: true })).toBeNull()
  })
})

describe('fetchRadiusQuota', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-13T21:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends a bearer-authenticated request and returns a balance-only snapshot', async () => {
    const fetchImpl = vi.fn(async () => mockResponse({ ok: true, status: 200, json: billingResponse }))

    const result = await fetchRadiusQuota('token', fetchImpl as unknown as typeof fetch)

    expect(fetchImpl).toHaveBeenCalledWith('https://radius.pi.dev/v1/billing', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer token' }),
    }))
    expect(result.status).toBe(200)
    expect(result.quota).toEqual({
      kind: 'radius',
      windows: [],
      balance: {
        currency: 'USD',
        total: 9.99077183,
        reserved: 1.01676073,
        available: 8.9740111,
        periodSpent: 0.00922817,
        periodEndsAt: '2026-10-01T00:00:00.000Z',
      },
      fetchedAt: '2026-09-13T21:00:00.000Z',
    })
  })

  it('surfaces HTTP errors with retry-after', async () => {
    const fetchImpl = vi.fn(async () => mockResponse({ ok: false, status: 429, headers: { 'retry-after': '30' } }))

    const result = await fetchRadiusQuota('token', fetchImpl as unknown as typeof fetch)

    expect(result).toEqual({ quota: null, status: 429, retryAfterMs: 30_000, error: 'HTTP 429' })
  })

  it('reports an unusable payload', async () => {
    const fetchImpl = vi.fn(async () => mockResponse({ ok: true, status: 200, json: { ok: false, error: 'unauthorized' } }))

    const result = await fetchRadiusQuota('token', fetchImpl as unknown as typeof fetch)

    expect(result.quota).toBeNull()
    expect(result.error).toMatch(/no usable balance/)
  })

  it('reports network errors', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('boom') })

    const result = await fetchRadiusQuota('token', fetchImpl as unknown as typeof fetch)

    expect(result).toEqual({ quota: null, error: 'boom' })
  })
})

describe('getRadiusQuotaForProvider', () => {
  it('rejects non-Radius providers', async () => {
    const result = await getRadiusQuotaForProvider({ ...apiKeyProvider, providerType: 'openrouter' })
    expect(result.quota).toBeNull()
    expect(result.error).toMatch(/not a Radius provider/)
  })

  it('uses the organization API key as bearer credential', async () => {
    const fetchImpl = vi.fn(async () => mockResponse({ ok: true, status: 200, json: billingResponse }))

    const result = await getRadiusQuotaForProvider(apiKeyProvider, fetchImpl as unknown as typeof fetch)

    expect(fetchImpl).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer radius-org-key' }),
    }))
    expect(result.quota?.balance?.available).toBe(8.9740111)
  })
})
