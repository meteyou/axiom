import type { ProviderConfig } from './provider-config.js'
import type { ProviderQuotaWindowContract } from './contracts/providers.js'
import {
  normalizeUtilization,
  parseRetryAfterMs,
  type ProviderQuotaFetchResult,
  type QuotaProviderAdapter,
} from './provider-quota.js'

const DASHBOARD_ENDPOINT_PREFIX = 'https://opencode.ai/workspace/'
const DASHBOARD_ENDPOINT_SUFFIX = '/go'
const DEFAULT_USER_AGENT = 'axiom-quota/1.0'

const WINDOW_DEFINITIONS = [
  { key: 'rolling', field: 'rollingUsage', label: '5h', resetDisplay: 'relative' },
  { key: 'weekly', field: 'weeklyUsage', label: '7d', resetDisplay: 'absolute' },
  { key: 'monthly', field: 'monthlyUsage', label: '30d', resetDisplay: 'absolute' },
] as const satisfies ReadonlyArray<{
  key: string
  field: string
  label: string
  resetDisplay: ProviderQuotaWindowContract['resetDisplay']
}>

interface OpenCodeGoQuotaCredentials {
  workspaceId: string
  authCookie: string
}

interface RawOpenCodeGoUsageWindow {
  usagePercent: number
  resetInSec: number
}

function envValue(name: string, env: NodeJS.ProcessEnv): string {
  return env[name]?.trim() ?? ''
}

export function resolveOpenCodeGoQuotaCredentials(
  env: NodeJS.ProcessEnv = process.env,
): OpenCodeGoQuotaCredentials | null {
  const workspaceId = envValue('OPENCODE_GO_WORKSPACE_ID', env)
  const authCookie = envValue('OPENCODE_GO_AUTH_COOKIE', env)
  if (!workspaceId || !authCookie) return null
  return { workspaceId, authCookie }
}

function hasOpenCodeGoQuotaCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(envValue('OPENCODE_GO_WORKSPACE_ID', env) && envValue('OPENCODE_GO_AUTH_COOKIE', env))
}

/** OpenCode Go quota is read from the web dashboard, not from the inference API key. */
export function isOpenCodeGoQuotaProvider(provider: ProviderConfig): boolean {
  return provider.providerType === 'opencode-go' && hasOpenCodeGoQuotaCredentials()
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function parseNumberField(text: string, field: string): number | null {
  const match = new RegExp(`${escapeRegExp(field)}\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`).exec(text)
  if (!match) return null
  const value = Number(match[1])
  return Number.isFinite(value) ? value : null
}

function parseHydrationWindow(html: string, field: string): RawOpenCodeGoUsageWindow | null {
  const match = new RegExp(`${escapeRegExp(field)}\\s*:\\s*\\$R\\[\\d+\\]\\s*=\\s*\\{([^}]*)\\}`).exec(html)
  if (!match) return null

  const usagePercent = parseNumberField(match[1], 'usagePercent')
  const resetInSec = parseNumberField(match[1], 'resetInSec')
  if (usagePercent === null || resetInSec === null) return null
  return { usagePercent, resetInSec }
}

function parseHumanDurationSeconds(value: string): number | null {
  const normalized = value.toLowerCase().replace(/\s+/g, ' ').trim()
  if (['now', 'reset now', 'resets now'].includes(normalized)) return 0

  const units: Array<[RegExp, number]> = [
    [/(\d+(?:\.\d+)?)\s*days?/, 86_400],
    [/(\d+(?:\.\d+)?)\s*hours?/, 3_600],
    [/(\d+(?:\.\d+)?)\s*minutes?/, 60],
    [/(\d+(?:\.\d+)?)\s*seconds?/, 1],
  ]

  let seconds = 0
  let matched = false
  for (const [regex, multiplier] of units) {
    const match = regex.exec(normalized)
    if (!match) continue
    matched = true
    seconds += Number(match[1]) * multiplier
  }

  return matched && Number.isFinite(seconds) ? seconds : null
}

function stripHtml(value: string): string {
  return value
    .replace(/<!--\$-->|<!--\/-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

function parseDataSlotWindows(html: string): Partial<Record<string, RawOpenCodeGoUsageWindow>> {
  const windows: Partial<Record<string, RawOpenCodeGoUsageWindow>> = {}
  const items = html.split(/data-slot=["']usage-item["']/)

  for (const item of items.slice(1)) {
    const labelMatch = /data-slot=["']usage-label["'][^>]*>([\s\S]*?)<\//.exec(item)
    const valueMatch = /data-slot=["']usage-value["'][^>]*>[\s\S]*?(\d+(?:\.\d+)?)/.exec(item)
    const resetMatch = /data-slot=["'](reset-time|reset-now)["'][^>]*>([\s\S]*?)<\/span>/.exec(item)
    if (!labelMatch || !valueMatch || !resetMatch) continue

    const label = stripHtml(labelMatch[1]).toLowerCase()
    const usagePercent = Number(valueMatch[1])
    const resetText = stripHtml(resetMatch[2]).replace(/^resets?\s+in\s+/i, '')
    const resetInSec = resetMatch[1] === 'reset-now' ? 0 : parseHumanDurationSeconds(resetText)
    if (!Number.isFinite(usagePercent) || resetInSec === null) continue

    const definition = WINDOW_DEFINITIONS.find((candidate) => label.includes(candidate.key))
    if (definition) windows[definition.key] = { usagePercent, resetInSec }
  }

  return windows
}

export function parseOpenCodeGoQuotaHtml(html: string): ProviderQuotaWindowContract[] {
  const dataSlotWindows = parseDataSlotWindows(html)
  const now = Date.now()

  return WINDOW_DEFINITIONS.flatMap((definition) => {
    const raw = parseHydrationWindow(html, definition.field) ?? dataSlotWindows[definition.key]
    if (!raw) return []

    const resetInSec = Math.max(0, raw.resetInSec)
    return [{
      key: definition.key,
      label: definition.label,
      utilization: normalizeUtilization(raw.usagePercent),
      resetsAt: new Date(now + resetInSec * 1000).toISOString(),
      resetDisplay: definition.resetDisplay,
    }]
  })
}

function openCodeGoDashboardUrl(workspaceId: string): string {
  return `${DASHBOARD_ENDPOINT_PREFIX}${encodeURIComponent(workspaceId)}${DASHBOARD_ENDPOINT_SUFFIX}`
}

function cookieHeader(authCookie: string): string {
  if (/\bauth=/.test(authCookie)) return authCookie
  return `auth=${authCookie}`
}

/** Fetch OpenCode Go usage by scraping the authenticated workspace dashboard. */
export async function fetchOpenCodeGoQuota(
  workspaceId: string,
  authCookie: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderQuotaFetchResult> {
  try {
    const response = await fetchImpl(openCodeGoDashboardUrl(workspaceId), {
      method: 'GET',
      headers: {
        Accept: 'text/html',
        Cookie: cookieHeader(authCookie),
        'User-Agent': DEFAULT_USER_AGENT,
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

    const html = await response.text()
    const windows = parseOpenCodeGoQuotaHtml(html)
    if (windows.length === 0) {
      return {
        quota: null,
        status: response.status,
        error: 'Could not parse OpenCode Go dashboard quota windows',
      }
    }

    return {
      quota: {
        kind: 'opencode-go',
        windows,
        plan: 'Go',
        fetchedAt: new Date().toISOString(),
      },
      status: response.status,
    }
  } catch (err) {
    return { quota: null, error: (err as Error).message || 'Network error' }
  }
}

export async function getOpenCodeGoQuotaForProvider(
  provider: ProviderConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderQuotaFetchResult> {
  if (provider.providerType !== 'opencode-go') {
    return { quota: null, error: 'Provider is not an OpenCode Go provider' }
  }

  const workspaceId = envValue('OPENCODE_GO_WORKSPACE_ID', process.env)
  const authCookie = envValue('OPENCODE_GO_AUTH_COOKIE', process.env)
  if (!workspaceId || !authCookie) {
    const missing = !workspaceId ? 'OPENCODE_GO_WORKSPACE_ID' : 'OPENCODE_GO_AUTH_COOKIE'
    return { quota: null, error: `Missing ${missing}` }
  }

  return fetchOpenCodeGoQuota(workspaceId, authCookie, fetchImpl)
}

export const opencodeGoQuotaAdapter: QuotaProviderAdapter = {
  kind: 'opencode-go',
  matches: isOpenCodeGoQuotaProvider,
  fetch: getOpenCodeGoQuotaForProvider,
}
