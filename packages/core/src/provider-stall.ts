import { loadConfig } from './config.js'
import { STALL_OUTCOMES } from './agent-runtime-types.js'
import type { StallInfo, StallOutcome } from './agent-runtime-types.js'

/** `chat_messages.metadata.kind` marking a persisted provider-stall notice. */
export const PROVIDER_STALL_KIND = 'provider_stall'

export const DEFAULT_STALL_WARN_MS = 30_000
export const DEFAULT_STALL_ABORT_MS = 90_000

export interface StallThresholds {
  warnMs: number
  abortMs: number
}

/**
 * Persisted shape of a stall notice. Written once when the warn threshold
 * fires (unresolved) and updated in place when the stall ends, so statistics
 * can aggregate over `durationMs` / `outcome` without reparsing chat text.
 */
export interface ProviderStallMetadata {
  kind: typeof PROVIDER_STALL_KIND
  startedAt: string
  resolvedAt: string | null
  durationMs: number
  outcome: StallOutcome | null
}

export function buildProviderStallMetadata(stall: StallInfo): ProviderStallMetadata {
  return {
    kind: PROVIDER_STALL_KIND,
    startedAt: stall.startedAt,
    resolvedAt: stall.resolvedAt ?? null,
    durationMs: stall.durationMs,
    outcome: stall.outcome ?? null,
  }
}

export function parseProviderStallMetadata(raw: string | null | undefined): ProviderStallMetadata | null {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null

  const value = parsed as Record<string, unknown>
  if (value.kind !== PROVIDER_STALL_KIND) return null
  if (typeof value.startedAt !== 'string') return null

  const outcome = typeof value.outcome === 'string' && (STALL_OUTCOMES as readonly string[]).includes(value.outcome)
    ? value.outcome as StallOutcome
    : null

  return {
    kind: PROVIDER_STALL_KIND,
    startedAt: value.startedAt,
    resolvedAt: typeof value.resolvedAt === 'string' ? value.resolvedAt : null,
    durationMs: typeof value.durationMs === 'number' ? value.durationMs : 0,
    outcome,
  }
}

/**
 * Human-readable body of the stall row. Channels that can render structured
 * data use `StallInfo`; this text is the fallback (Telegram, old clients) and
 * what a history reload shows verbatim.
 */
export function formatProviderStallContent(stall: StallInfo): string {
  const seconds = Math.max(1, Math.round(stall.durationMs / 1000))
  if (stall.outcome === 'recovered') return `\u2705 Provider recovered after ${seconds}s of silence`
  if (stall.outcome === 'aborted') return `\u26A0\uFE0F Provider stopped responding \u2014 aborted after ${seconds}s of silence`
  return `\u23F3 Provider has not responded for ${seconds}s\u2026`
}

interface WatchdogSettingsFile {
  watchdog?: {
    stallWarnMs?: unknown
    stallAbortMs?: unknown
  }
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * Read the watchdog thresholds from `settings.json`. Config-file only for now;
 * a missing/unreadable file falls back to the 30 s / 90 s defaults.
 */
export function loadStallThresholds(
  load: () => WatchdogSettingsFile = () => loadConfig<WatchdogSettingsFile>('settings.json'),
): StallThresholds {
  let watchdog: WatchdogSettingsFile['watchdog']
  try {
    watchdog = load().watchdog
  } catch {
    watchdog = undefined
  }

  return {
    warnMs: positiveNumber(watchdog?.stallWarnMs, DEFAULT_STALL_WARN_MS),
    abortMs: positiveNumber(watchdog?.stallAbortMs, DEFAULT_STALL_ABORT_MS),
  }
}
