export interface TaskToolCallTimelineEvent {
  type: 'tool_call'
  timestamp: string | undefined
  toolName: string
  input: string
  output: string
  durationMs: number
  status: 'success' | 'error'
}

export interface TaskMessageTimelineEvent {
  type: 'message'
  timestamp: string
  role: string
  content: string
  metadata: unknown
}

export type TaskTimelineEvent = TaskToolCallTimelineEvent | TaskMessageTimelineEvent
