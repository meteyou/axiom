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
}

export interface AgentRuntimeStateSnapshot {
  modelId: string
  toolNames: string[]
  messageCount: number
}
