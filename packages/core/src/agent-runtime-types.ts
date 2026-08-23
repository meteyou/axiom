export const STALL_OUTCOMES = ['recovered', 'aborted'] as const

/** How a provider stall ended: the stream came back, or the turn was killed. */
export type StallOutcome = (typeof STALL_OUTCOMES)[number]

/**
 * Machine-readable payload of `stall_warning` / `stall_resolved` chunks and of
 * the `provider_stall` chat row they persist. `messageId` is what lets a
 * channel update the already-rendered warning in place instead of appending a
 * second bubble when the stall resolves.
 */
export interface StallInfo {
  /** `chat_messages` row id of the persisted stall notice, when persisted. */
  messageId?: number
  /** ISO timestamp of the last provider activity before the silence. */
  startedAt: string
  /** ISO timestamp of the moment the stall ended. */
  resolvedAt?: string
  /** Silence duration in ms — elapsed idle time so far while unresolved. */
  durationMs: number
  outcome?: StallOutcome
}

export interface ResponseChunk {
  type: 'text' | 'thinking' | 'tool_call_start' | 'tool_call_end' | 'error' | 'done' | 'stall_warning' | 'stall_resolved'
  text?: string
  /** Streamed thinking/reasoning delta (for `type: 'thinking'`) */
  thinking?: string
  toolName?: string
  toolCallId?: string
  toolArgs?: unknown
  toolResult?: unknown
  toolIsError?: boolean
  error?: string
  /** Session ID associated with this chunk (used by task-injection streaming). */
  sessionId?: string
  /**
   * Unique per-injection correlation token for task-injection streams.
   * Callers that need to correlate chunks against pre-registered metadata
   * (see `runtime-composition.ts`) must key off this — NOT `sessionId` —
   * because multiple concurrent injections for the same user share the
   * same cached session id, which would otherwise collide.
   */
  injectionId?: string
  /** Stall details (for `type: 'stall_warning' | 'stall_resolved'`). */
  stall?: StallInfo
}

export interface AgentRuntimeStateSnapshot {
  modelId: string
  toolNames: string[]
  messageCount: number
}
