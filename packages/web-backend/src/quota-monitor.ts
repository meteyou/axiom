import {
  getAnthropicQuotaForProvider,
  isAnthropicOAuthProvider,
  loadProvidersDecrypted,
} from '@axiom/core'
import type { AnthropicQuotaContract } from '@axiom/core/contracts'
import type { ProviderConfig } from '@axiom/core'

const DEFAULT_POLL_INTERVAL_MS = 10 * 60 * 1000
const INITIAL_BACKOFF_MS = 15 * 60 * 1000
const MAX_BACKOFF_MS = 2 * 60 * 60 * 1000

interface ProviderBackoff {
  rateLimitedUntil: number
  currentBackoffMs: number
}

export interface QuotaMonitorServiceOptions {
  pollIntervalMs?: number
  fetchImpl?: typeof fetch
  now?: () => number
  logger?: Pick<typeof console, 'error'>
}

/**
 * Background poller for Anthropic subscriber (OAuth) usage quotas.
 *
 * Polls every `anthropic-oauth` provider on an interval and caches the latest
 * usage snapshot in memory keyed by provider id. This is independent of which
 * provider is "active" — the usage endpoint is read-only and works for any
 * provider that holds OAuth credentials.
 */
export class QuotaMonitorService {
  private pollIntervalMs: number
  private fetchImpl: typeof fetch
  private now: () => number
  private logger: Pick<typeof console, 'error'>
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private cache = new Map<string, AnthropicQuotaContract>()
  private backoff = new Map<string, ProviderBackoff>()

  constructor(options: QuotaMonitorServiceOptions = {}) {
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? (() => Date.now())
    this.logger = options.logger ?? console
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.scheduleNext(0)
  }

  stop(): void {
    this.running = false
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  getSnapshot(): Record<string, AnthropicQuotaContract> {
    return Object.fromEntries(this.cache)
  }

  /**
   * Force an immediate, on-demand usage fetch for a single provider, bypassing
   * the rate-limit backoff. Returns the resulting cached snapshot (or null if
   * the provider no longer exists / is not an Anthropic OAuth subscriber).
   */
  async refreshProvider(providerId: string): Promise<AnthropicQuotaContract | null> {
    const provider = this.loadOAuthProviders().find((p) => p.id === providerId)
    if (!provider) return null
    await this.pollProvider(provider, { force: true })
    return this.cache.get(providerId) ?? null
  }

  private scheduleNext(delayMs: number): void {
    if (!this.running) return

    if (this.timer) {
      clearTimeout(this.timer)
    }

    this.timer = setTimeout(() => {
      this.runPoll()
        .catch((err) => {
          this.logger.error('[axiom] Quota monitor poll failed:', err)
        })
        .finally(() => {
          this.scheduleNext(this.pollIntervalMs)
        })
    }, Math.max(0, delayMs))

    if (typeof this.timer === 'object' && 'unref' in this.timer) {
      this.timer.unref()
    }
  }

  private loadOAuthProviders() {
    try {
      return loadProvidersDecrypted().providers.filter(isAnthropicOAuthProvider)
    } catch (err) {
      this.logger.error('[axiom] Quota monitor failed to load providers:', err)
      return []
    }
  }

  private async runPoll(): Promise<void> {
    const providers = this.loadOAuthProviders()
    const liveIds = new Set(providers.map((p) => p.id))

    // Drop cache/backoff for providers that no longer exist or lost OAuth.
    for (const id of [...this.cache.keys()]) {
      if (!liveIds.has(id)) this.cache.delete(id)
    }
    for (const id of [...this.backoff.keys()]) {
      if (!liveIds.has(id)) this.backoff.delete(id)
    }

    await Promise.all(providers.map((provider) => this.pollProvider(provider)))
  }

  private async pollProvider(provider: ProviderConfig, opts: { force?: boolean } = {}): Promise<void> {
    const now = this.now()
    const state = this.backoff.get(provider.id)

    // Respect per-provider rate-limit backoff (unless forced by a manual
    // refresh); keep the stale cached value in the meantime.
    if (!opts.force && state && now < state.rateLimitedUntil) return

    const result = await getAnthropicQuotaForProvider(provider, this.fetchImpl)

    if (result.quota) {
      this.backoff.delete(provider.id)
      this.cache.set(provider.id, {
        fiveHour: result.quota.fiveHour,
        sevenDay: result.quota.sevenDay,
        sevenDayOpus: result.quota.sevenDayOpus,
        sevenDaySonnet: result.quota.sevenDaySonnet,
        fetchedAt: result.quota.fetchedAt,
      })
      return
    }

    if (result.status === 429) {
      const previous = state?.currentBackoffMs ?? INITIAL_BACKOFF_MS
      const backoffMs = result.retryAfterMs ?? previous
      this.backoff.set(provider.id, {
        rateLimitedUntil: now + backoffMs,
        currentBackoffMs: result.retryAfterMs ? previous : Math.min(previous * 2, MAX_BACKOFF_MS),
      })
    }

    // Preserve a previously successful snapshot on transient failures (429
    // rate-limit, network errors, 5xx) so the UI keeps showing the last known
    // usage instead of flapping to "unavailable" — the Anthropic usage endpoint
    // is aggressively rate-limited. Only surface an error entry when there is no
    // good data yet, or for hard failures (e.g. 401/403) the user must act on.
    const existing = this.cache.get(provider.id)
    const hasGoodData = !!existing && !existing.error
    const isTransient =
      result.status === 429 ||
      result.status === undefined ||
      (typeof result.status === 'number' && result.status >= 500)
    if (!hasGoodData || !isTransient) {
      this.cache.set(provider.id, {
        fiveHour: null,
        sevenDay: null,
        sevenDayOpus: null,
        sevenDaySonnet: null,
        fetchedAt: new Date(now).toISOString(),
        error: result.error ?? 'Failed to fetch usage',
      })
    }
  }
}
