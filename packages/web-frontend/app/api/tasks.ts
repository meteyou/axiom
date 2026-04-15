export interface Task {
  id: string
  name: string
  prompt: string
  status: 'running' | 'paused' | 'completed' | 'failed'
  triggerType: 'user' | 'agent' | 'cronjob' | 'heartbeat' | 'consolidation'
  triggerSourceId: string | null
  provider: string | null
  model: string | null
  maxDurationMinutes: number | null
  promptTokens: number
  completionTokens: number
  estimatedCost: number
  toolCallCount: number
  resultSummary: string | null
  resultStatus: string | null
  errorMessage: string | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  sessionId: string | null
}

export interface TasksResponse {
  tasks: Task[]
  pagination: {
    page: number
    limit: number
    total: number
    totalPages: number
  }
}

export interface TaskResponse {
  task: Task
}

export interface TaskInfo {
  id: string
  name: string
  status: string
  prompt?: string | null
  resultSummary?: string | null
  errorMessage?: string | null
}

export interface TaskEventItem {
  type: string
  timestamp: string
  toolName?: string
  toolCallId?: string
  toolArgs?: unknown
  toolResult?: unknown
  toolIsError?: boolean
  durationMs?: number
  text?: string
  status?: string
  statusMessage?: string
  // For REST API tool_call events
  input?: string
  output?: string
  // For REST API message events
  role?: string
  content?: string
  metadata?: unknown
  thinking?: string
}

export interface TaskEventsResponse {
  events: TaskEventItem[]
  task: TaskInfo
}

export interface ListTasksParams {
  page?: number
  limit?: number
  status?: string
  triggerType?: string
}

export function useTasksApi() {
  const { apiFetch } = useApi()

  async function listTasks(params: ListTasksParams = {}): Promise<TasksResponse> {
    const query = new URLSearchParams()

    if (params.page !== undefined) query.set('page', String(params.page))
    if (params.limit !== undefined) query.set('limit', String(params.limit))
    if (params.status) query.set('status', params.status)
    if (params.triggerType) query.set('trigger_type', params.triggerType)

    const suffix = query.toString()
    return apiFetch<TasksResponse>(`/api/tasks${suffix ? `?${suffix}` : ''}`)
  }

  async function getTask(taskId: string): Promise<TaskResponse> {
    return apiFetch<TaskResponse>(`/api/tasks/${taskId}`)
  }

  async function getTaskEvents(taskId: string): Promise<TaskEventsResponse> {
    return apiFetch<TaskEventsResponse>(`/api/tasks/${taskId}/events`)
  }

  async function killTask(taskId: string): Promise<TaskResponse> {
    return apiFetch<TaskResponse>(`/api/tasks/${taskId}/kill`, { method: 'POST' })
  }

  return {
    listTasks,
    getTask,
    getTaskEvents,
    killTask,
  }
}
