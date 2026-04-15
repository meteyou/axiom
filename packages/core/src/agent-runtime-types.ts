export interface ResponseChunk {
  type: 'text' | 'tool_call_start' | 'tool_call_end' | 'error' | 'done'
  text?: string
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
