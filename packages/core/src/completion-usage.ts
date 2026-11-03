import type { Api, AssistantMessage, Model } from '@earendil-works/pi-ai'
import type { Database } from './database.js'
import { estimateCost } from './provider-config.js'
import { logTokenUsage } from './token-logger.js'

export interface CompletionUsageContext {
  db: Database
  sessionId?: string | null
  /** Owner when the call has no session. */
  userId?: number | null
}

/**
 * Book a one-off LLM call (`completeSimple`) in `token_usage` the way chat
 * turns are booked: the provider-reported cost when present, otherwise the
 * estimate from the model's prices.
 */
export function logCompletionUsage(context: CompletionUsageContext | undefined, model: Model<Api>, message: AssistantMessage): void {
  const usage = message.usage
  if (!context || !usage) return
  const reported = usage.cost?.total ?? 0
  try {
    logTokenUsage(context.db, {
      provider: message.provider || model.provider,
      model: message.model || model.id,
      promptTokens: usage.input,
      completionTokens: usage.output,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      estimatedCost: reported > 0 ? reported : estimateCost(model, usage.input, usage.output, usage.cacheRead, usage.cacheWrite),
      sessionId: context.sessionId ?? undefined,
      userId: context.userId ?? null,
    })
  } catch (err) {
    console.error('[completion-usage] Failed to book LLM usage:', err)
  }
}
