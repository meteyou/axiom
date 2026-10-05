import { CONTEXT_COMPACTION_REASONS, CONTEXT_COMPACTION_STATUSES } from './agent-runtime-types.js'
import type { ContextCompactionInfo, ContextCompactionReason, ContextCompactionStatus } from './agent-runtime-types.js'

/** `chat_messages.metadata.kind` marking a persisted compaction notice. */
export const CONTEXT_COMPACTION_KIND = 'context_compaction'

export interface ContextCompactionMetadata {
  kind: typeof CONTEXT_COMPACTION_KIND
  compactionId: string
  status: ContextCompactionStatus
  reason: ContextCompactionReason
  tokensBefore: number
  tokensAfter?: number
  summary?: string
  error?: string
  occurredAt: string
}

/** `368000` → `368k`, `1250000` → `1.3M`. */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`
  return String(Math.max(0, Math.round(tokens)))
}

/** Single-line text for plain-text channels (Telegram) and history fallbacks. */
export function formatContextCompactionContent(info: ContextCompactionInfo): string {
  switch (info.status) {
    case 'running':
      return `\u{1F5DC}\uFE0F Compacting context (${formatTokenCount(info.tokensBefore)} tokens)\u2026`
    case 'completed':
      return `\u{1F5DC}\uFE0F Context compacted (${formatTokenCount(info.tokensBefore)} \u2192 ${formatTokenCount(info.tokensAfter ?? 0)} tokens)`
    case 'skipped':
      return `\u{1F5DC}\uFE0F ${info.error ?? 'Nothing to compact yet.'}`
    case 'failed':
      return `\u26A0\uFE0F Context compaction failed: ${info.error ?? 'unknown error'}`
  }
}

/** Only finished compactions are worth keeping in the chat history. */
export function isPersistableCompaction(info: ContextCompactionInfo): boolean {
  return info.status !== 'running'
}

export function buildContextCompactionMetadata(info: ContextCompactionInfo): ContextCompactionMetadata {
  return {
    kind: CONTEXT_COMPACTION_KIND,
    compactionId: info.compactionId,
    status: info.status,
    reason: info.reason,
    tokensBefore: info.tokensBefore,
    ...(info.tokensAfter !== undefined ? { tokensAfter: info.tokensAfter } : {}),
    ...(info.summary ? { summary: info.summary } : {}),
    ...(info.error ? { error: info.error } : {}),
    occurredAt: info.occurredAt,
  }
}

function oneOf<T extends string>(values: readonly T[], value: unknown, fallback: T): T {
  return typeof value === 'string' && (values as readonly string[]).includes(value) ? value as T : fallback
}

export function parseContextCompactionMetadata(raw: string | null | undefined): ContextCompactionMetadata | null {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const value = parsed as Record<string, unknown>
  if (value.kind !== CONTEXT_COMPACTION_KIND || typeof value.compactionId !== 'string') return null
  return {
    kind: CONTEXT_COMPACTION_KIND,
    compactionId: value.compactionId,
    status: oneOf(CONTEXT_COMPACTION_STATUSES, value.status, 'completed'),
    reason: oneOf(CONTEXT_COMPACTION_REASONS, value.reason, 'threshold'),
    tokensBefore: typeof value.tokensBefore === 'number' ? value.tokensBefore : 0,
    ...(typeof value.tokensAfter === 'number' ? { tokensAfter: value.tokensAfter } : {}),
    ...(typeof value.summary === 'string' ? { summary: value.summary } : {}),
    ...(typeof value.error === 'string' ? { error: value.error } : {}),
    occurredAt: typeof value.occurredAt === 'string' ? value.occurredAt : '',
  }
}
