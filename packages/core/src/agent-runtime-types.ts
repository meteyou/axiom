export interface ResponseChunk {
  type: 'text' | 'thinking' | 'tool_call_start' | 'tool_call_end' | 'error' | 'done'
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
}

export interface AgentRuntimeStateSnapshot {
  modelId: string
  toolNames: string[]
  messageCount: number
}
