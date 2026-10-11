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
  tokensAfter?: number
  summary?: string
  /** Why the compaction was skipped or failed. */
  error?: string
  warnings?: ContextCompactionWarning[]
  /** `chat_messages` row id of the persisted notice, when persisted. */
  messageId?: number
  occurredAt: string
}

/** `chat_messages.metadata.kind` marking a persisted compaction notice. */
export const CONTEXT_COMPACTION_KIND = 'context_compaction'

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
    ...(typeof value.summary === 'string' ? { summary: value.summary } : {}),
    ...(typeof value.error === 'string' ? { error: value.error } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(messageId !== undefined ? { messageId } : {}),
    occurredAt: typeof value.occurredAt === 'string' ? value.occurredAt : '',
  }
}
