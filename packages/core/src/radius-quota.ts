import type { ProviderConfig } from './provider-config.js'
import { getApiKeyForProvider, isRadiusProviderType } from './provider-config.js'
import type { ProviderQuotaBalanceContract } from './contracts/providers.js'
import {
  parseRetryAfterMs,
  type ProviderQuotaFetchResult,
  type QuotaProviderAdapter,
} from './provider-quota.js'
import { DEFAULT_RADIUS_GATEWAY } from '@earendil-works/pi-ai/providers/radius-config'

// Undocumented gateway endpoint (not part of pi-ai). Accepts the same bearer
// credential as `/v1/config` (OAuth access token or organization API key).
const BILLING_ENDPOINT = `${DEFAULT_RADIUS_GATEWAY}/v1/billing`

/** Shape returned by /v1/billing (only the fields we consume). */
interface RawRadiusBillingResponse {
  ok?: boolean
  currency?: string
  balance?: {
    credit_balance?: number
    reserved?: number
    available?: number
  }
  current_period?: {
    ends_at?: string
    actual_charged?: number
  }
}

/** Both Radius auth methods can read the organization's billing balance. */
export function isRadiusQuotaProvider(provider: ProviderConfig): boolean {
  if (!isRadiusProviderType(provider.providerType)) return false
  return provider.authMethod === 'oauth' ? !!provider.oauthCredentials : !!provider.apiKey
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function parseRadiusBalance(data: RawRadiusBillingResponse): ProviderQuotaBalanceContract | null {
  const total = finiteOrNull(data.balance?.credit_balance)
  if (total === null) return null

  const reserved = finiteOrNull(data.balance?.reserved) ?? 0
  const available = finiteOrNull(data.balance?.available) ?? Math.max(0, total - reserved)
  const periodEndsAt = data.current_period?.ends_at
  return {
    currency: typeof data.currency === 'string' && data.currency ? data.currency : 'USD',
    total,
    reserved,
    available,
    periodSpent: finiteOrNull(data.current_period?.actual_charged),
    periodEndsAt: typeof periodEndsAt === 'string' && !Number.isNaN(Date.parse(periodEndsAt)) ? periodEndsAt : null,
  }
}

export async function fetchRadiusQuota(
  credential: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderQuotaFetchResult> {
  try {
    const response = await fetchImpl(BILLING_ENDPOINT, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${credential}`,
      },
    })

    if (!response.ok) {
      return {
        quota: null,
        status: response.status,
        retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after')),
        error: `HTTP ${response.status}`,
      }
    }

    const data = (await response.json()) as RawRadiusBillingResponse
    const balance = data.ok === false ? null : parseRadiusBalance(data)
    if (!balance) {
      return {
        quota: null,
        status: response.status,
        error: 'Radius billing API returned no usable balance',
      }
    }

    return {
      quota: {
        kind: 'radius',
        windows: [],
        balance,
        fetchedAt: new Date().toISOString(),
      },
      status: response.status,
    }
  } catch (err) {
    return { quota: null, error: (err as Error).message || 'Network error' }
  }
}

export async function getRadiusQuotaForProvider(
  provider: ProviderConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderQuotaFetchResult> {
  if (!isRadiusQuotaProvider(provider)) {
    return { quota: null, error: 'Provider is not a Radius provider' }
  }

  let credential: string
  try {
    credential = await getApiKeyForProvider(provider)
  } catch (err) {
    return { quota: null, error: (err as Error).message || 'Failed to resolve credential' }
  }

  if (!credential || credential === 'no-key') {
    return { quota: null, error: 'No Radius credential available' }
  }

  return fetchRadiusQuota(credential, fetchImpl)
}

export const radiusQuotaAdapter: QuotaProviderAdapter = {
  kind: 'radius',
  matches: isRadiusQuotaProvider,
  fetch: getRadiusQuotaForProvider,
}
