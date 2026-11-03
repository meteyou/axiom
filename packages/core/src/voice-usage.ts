import type { Database } from './database.js'
import type { ProviderConfig } from './provider-config.js'
import { logTokenUsage } from './token-logger.js'
import type { VoiceModelKind } from './voice-capabilities.js'

/** Where a speech request is booked in `token_usage`. */
export interface VoiceUsageContext {
  db: Database
  sessionId?: string | null
  /** Owner when the request has no session (e.g. the chat's read-aloud button). */
  userId?: number | null
}

/**
 * USD per 1M units of a voice model — input characters (TTS) or audio seconds
 * (STT) — stored as `cost.input` of its `models[]` entry.
 */
export function getVoiceModelUnitPrice(provider: ProviderConfig, modelId: string): number | undefined {
  const price = provider.models?.find(model => model.id === modelId)?.cost?.input
  return typeof price === 'number' && Number.isFinite(price) && price >= 0 ? price : undefined
}

export interface VoiceUsageEntry {
  kind: VoiceModelKind
  provider: ProviderConfig
  modelId: string
  /** Input characters (TTS) or audio seconds (STT). */
  units: number
  /** Cost billed by the provider; wins over the configured unit price. */
  costUsd?: number
}

export function logVoiceUsage(context: VoiceUsageContext | undefined, entry: VoiceUsageEntry): void {
  if (!context) return
  const price = getVoiceModelUnitPrice(entry.provider, entry.modelId)
  const estimatedCost = entry.costUsd ?? (price !== undefined ? (entry.units * price) / 1_000_000 : 0)
  try {
    logTokenUsage(context.db, {
      provider: entry.provider.provider,
      model: entry.modelId,
      promptTokens: 0,
      completionTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
      estimatedCost,
      sessionId: context.sessionId ?? undefined,
      userId: context.userId ?? null,
      kind: entry.kind,
      units: entry.units,
    })
  } catch (err) {
    console.error(`[voice-usage] Failed to book ${entry.kind} usage:`, err)
  }
}
