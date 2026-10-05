import type { ProviderConfig } from './provider-config.js'
import { PROVIDER_TYPE_PRESETS, getApiKeyForProvider } from './provider-config.js'
import type { ProviderQuotaBalanceContract } from './contracts/providers.js'
import {
  parseRetryAfterMs,
  type ProviderQuotaFetchResult,
  type QuotaProviderAdapter,
} from './provider-quota.js'

const OPENROUTER_API_BASE = PROVIDER_TYPE_PRESETS.openrouter.baseUrl
const KEY_ENDPOINT = `${OPENROUTER_API_BASE}/key`
const CREDITS_ENDPOINT = `${OPENROUTER_API_BASE}/credits`

/** Shape returned by `GET /api/v1/key` (only the fields we consume). */
interface RawOpenRouterKeyResponse {
  data?: {
    limit?: number | null
    limit_remaining?: number | null
    usage_monthly?: number
  }
}

/** Shape returned by `GET /api/v1/credits` (only the fields we consume). */
interface RawOpenRouterCreditsResponse {
  data?: {
    total_credits?: number
    total_usage?: number
  }
}

export function isOpenRouterQuotaProvider(provider: ProviderConfig): boolean {
  return provider.providerType === 'openrouter' && !!provider.apiKey
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function startOfNextUtcMonth(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString()
}

/**
 * Combine the account balance (`/credits`) with the key's own spending cap
 * (`/key`). New requests are limited by whichever is lower, so `available` is
 * the minimum of both while `total` stays the account balance. Without a
 * readable account balance the key cap is the only known budget; an
 * unlimited key without account data has no balance to report.
 */
export function parseOpenRouterBalance(
  key: RawOpenRouterKeyResponse | null,
  credits: RawOpenRouterCreditsResponse | null,
  now: Date = new Date(),
): ProviderQuotaBalanceContract | null {
  const totalCredits = finiteOrNull(credits?.data?.total_credits)
  const totalUsage = finiteOrNull(credits?.data?.total_usage)
  const accountBalance = totalCredits !== null && totalUsage !== null ? totalCredits - totalUsage : null
  const keyRemaining = finiteOrNull(key?.data?.limit_remaining)

  const total = accountBalance ?? keyRemaining
  if (total === null) return null

  const spendable = keyRemaining !== null ? Math.min(total, keyRemaining) : total
  const periodSpent = finiteOrNull(key?.data?.usage_monthly)
  return {
    currency: 'USD',
    total,
    reserved: 0,
    available: Math.max(0, spendable),
    periodSpent,
    periodEndsAt: periodSpent !== null ? startOfNextUtcMonth(now) : null,
  }
}

interface JsonFetchResult<T> {
  data: T | null
  status?: number
  retryAfterMs?: number
  error?: string
}

async function fetchOpenRouterJson<T>(
  url: string,
  apiKey: string,
  fetchImpl: typeof fetch,
): Promise<JsonFetchResult<T>> {
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
    })
    if (!response.ok) {
      return {
        data: null,
        status: response.status,
        retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after')),
        error: `HTTP ${response.status}`,
      }
    }
    return { data: (await response.json()) as T, status: response.status }
  } catch (err) {
    return { data: null, error: (err as Error).message || 'Network error' }
  }
}

/**
 * `/key` works with any inference key. `/credits` is documented as
 * management-key only but currently also answers inference keys, so its
 * failure is tolerated and the snapshot falls back to the key's credit cap.
 */
export async function fetchOpenRouterQuota(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderQuotaFetchResult> {
  const [keyResult, creditsResult] = await Promise.all([
    fetchOpenRouterJson<RawOpenRouterKeyResponse>(KEY_ENDPOINT, apiKey, fetchImpl),
    fetchOpenRouterJson<RawOpenRouterCreditsResponse>(CREDITS_ENDPOINT, apiKey, fetchImpl),
  ])

  if (!keyResult.data) {
    return {
      quota: null,
      status: keyResult.status,
      retryAfterMs: keyResult.retryAfterMs,
      error: keyResult.error,
    }
  }

  const balance = parseOpenRouterBalance(keyResult.data, creditsResult.data)
  if (!balance) {
    return {
      quota: null,
      status: creditsResult.status,
      retryAfterMs: creditsResult.retryAfterMs,
      error: 'OpenRouter returned no usable balance (key has no credit limit and the account balance is not readable)',
    }
  }

  return {
    quota: {
      kind: 'openrouter',
      windows: [],
      balance,
      fetchedAt: new Date().toISOString(),
    },
    status: keyResult.status,
  }
}

export async function getOpenRouterQuotaForProvider(
  provider: ProviderConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderQuotaFetchResult> {
  if (!isOpenRouterQuotaProvider(provider)) {
    return { quota: null, error: 'Provider is not an OpenRouter provider' }
  }

  let apiKey: string
  try {
    apiKey = await getApiKeyForProvider(provider)
  } catch (err) {
    return { quota: null, error: (err as Error).message || 'Failed to resolve credential' }
  }

  if (!apiKey || apiKey === 'no-key') {
    return { quota: null, error: 'No OpenRouter API key available' }
  }

  return fetchOpenRouterQuota(apiKey, fetchImpl)
}

export const openrouterQuotaAdapter: QuotaProviderAdapter = {
  kind: 'openrouter',
  matches: isOpenRouterQuotaProvider,
  fetch: getOpenRouterQuotaForProvider,
}
