export const CONTEXT_COMPACTION_STATUSES = ['running', 'completed', 'skipped', 'failed'] as const
export type ContextCompactionStatus = (typeof CONTEXT_COMPACTION_STATUSES)[number]

export const CONTEXT_COMPACTION_REASONS = ['threshold', 'overflow', 'manual'] as const
export type ContextCompactionReason = (typeof CONTEXT_COMPACTION_REASONS)[number]

/**
 * Problems a finished compaction reports to the user:
 * - `window_too_small`: system prompt + summary + kept tail leave too little
 *   headroom below the trigger, so compaction will re-trigger often
 * - `auto_paused`: the compaction could not get the context below the
 *   trigger; automatic compaction waits until the conversation has grown
 */
export const CONTEXT_COMPACTION_WARNINGS = ['window_too_small', 'auto_paused'] as const
export type ContextCompactionWarning = (typeof CONTEXT_COMPACTION_WARNINGS)[number]

/**
 * Machine-readable payload of a `compaction` chunk and of the
 * `context_compaction` chat row a finished compaction persists. `running` is
 * live-only and repeats while the summary call is in flight, which also keeps
 * the stall watchdog from mistaking a long summary for a dead provider.
 */
export interface ContextCompactionInfo {
  compactionId: string
  status: ContextCompactionStatus
  reason: ContextCompactionReason
  tokensBefore: number
  /**
   * Context size right after the compaction: a heuristic estimate at first,
   * replaced by the provider-reported size once the next response arrives.
   */
  tokensAfter?: number
  /** `tokensAfter` comes from the provider's usage report, not the estimate. */
  tokensAfterMeasured?: boolean
  summary?: string
  /** Why the compaction was skipped or failed. */
  error?: string
  warnings?: ContextCompactionWarning[]
  /** `chat_messages` row id of the persisted notice, when persisted. */
  messageId?: number
  occurredAt: string
}

/** How full the main agent's context window is, for the chat header and `/context`. */
export interface ContextUsageInfo {
  tokens: number
  /** No provider usage since the session started or the last compaction; `tokens` is a heuristic. */
  estimated: boolean
  contextWindow: number
  /** Automatic compaction starts once the context grows beyond this. */
  compactionThreshold: number
  modelId: string
  modelName: string
  autoCompaction: boolean
  /** Automatic compaction is paused because the last one could not get below the threshold. */
  autoCompactionPaused: boolean
}

export function contextUsagePercent(tokens: number, contextWindow: number): number {
  return contextWindow > 0 ? Math.min(100, Math.round((tokens / contextWindow) * 100)) : 0
}

/** Plain-text summary for `/context`. */
export function formatContextUsage(info: ContextUsageInfo): string {
  const tokens = `${info.estimated ? '~' : ''}${formatTokenCount(info.tokens)}`
  const compaction = !info.autoCompaction
    ? 'Automatic compaction: off'
    : info.autoCompactionPaused
      ? 'Automatic compaction: paused, the context is still above the threshold'
      : `Automatic compaction at ${formatTokenCount(info.compactionThreshold)} `
        + `(${contextUsagePercent(info.compactionThreshold, info.contextWindow)}%)`
  return [
    `\u{1F9E0} Context: ${tokens} / ${formatTokenCount(info.contextWindow)} tokens `
      + `(${contextUsagePercent(info.tokens, info.contextWindow)}%)`,
    compaction,
    `Model: ${info.modelName}`,
  ].join('\n')
}

/** `chat_messages.metadata.kind` marking a persisted compaction notice. */
export const CONTEXT_COMPACTION_KIND = 'context_compaction'

/** `tokensAfter` for display: estimates are marked with `~`. */
export function formatTokensAfter(info: Pick<ContextCompactionInfo, 'tokensAfter' | 'tokensAfterMeasured'>): string {
  const formatted = formatTokenCount(info.tokensAfter ?? 0)
  return info.tokensAfterMeasured ? formatted : `~${formatted}`
}

/** `368000` → `368k`, `1250000` → `1.3M`. */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`
  return String(Math.max(0, Math.round(tokens)))
}

function oneOf<T extends string>(values: readonly T[], value: unknown, fallback: T): T {
  return typeof value === 'string' && (values as readonly string[]).includes(value) ? value as T : fallback
}

/** Rebuild the info of a persisted `context_compaction` row from its parsed metadata. */
export function parseContextCompactionInfo(metadata: unknown, messageId?: number): ContextCompactionInfo | null {
  if (!metadata || typeof metadata !== 'object') return null
  const value = metadata as Record<string, unknown>
  if (value.kind !== CONTEXT_COMPACTION_KIND || typeof value.compactionId !== 'string') return null
  const warnings = Array.isArray(value.warnings)
    ? value.warnings.filter((w): w is ContextCompactionWarning => (CONTEXT_COMPACTION_WARNINGS as readonly unknown[]).includes(w))
    : []
  return {
    compactionId: value.compactionId,
    status: oneOf(CONTEXT_COMPACTION_STATUSES, value.status, 'completed'),
    reason: oneOf(CONTEXT_COMPACTION_REASONS, value.reason, 'threshold'),
    tokensBefore: typeof value.tokensBefore === 'number' ? value.tokensBefore : 0,
    ...(typeof value.tokensAfter === 'number' ? { tokensAfter: value.tokensAfter } : {}),
    ...(value.tokensAfterMeasured === true ? { tokensAfterMeasured: true } : {}),
    ...(typeof value.summary === 'string' ? { summary: value.summary } : {}),
    ...(typeof value.error === 'string' ? { error: value.error } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(messageId !== undefined ? { messageId } : {}),
    occurredAt: typeof value.occurredAt === 'string' ? value.occurredAt : '',
  }
}
