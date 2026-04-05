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

interface TaskInfo {
  id: string
  name: string
  status: string
  prompt?: string
  resultSummary?: string
  errorMessage?: string
}

interface TaskEventsResponse {
  events: TaskEventItem[]
  task: TaskInfo
}

/**
 * Composable for viewing task events — live via WebSocket or historical via REST API.
 */
export function useTaskViewer() {
  const { apiFetch } = useApi()
  const { getAccessToken } = useAuth()
  const config = useRuntimeConfig()

  const events = ref<TaskEventItem[]>([])
  const taskInfo = ref<TaskInfo | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)
  const isLive = ref(false)

  let ws: WebSocket | null = null
  // Track pending tool calls (tool_call_start without matching tool_call_end)
  const pendingToolCalls = new Map<string, TaskEventItem>()

  /**
   * Accumulated text for grouping text_delta events
   */
  const textBuffer = ref('')

  /**
   * Load task events — uses WebSocket for running tasks, REST for completed/failed
   */
  async function loadTaskEvents(taskId: string) {
    loading.value = true
    error.value = null
    events.value = []
    taskInfo.value = null
    textBuffer.value = ''
    pendingToolCalls.clear()

    try {
      // First fetch task info to determine if we need live or historical
      const taskData = await apiFetch<{ task: TaskInfo }>(`/api/tasks/${taskId}`)
      taskInfo.value = taskData.task

      if (taskData.task.status === 'running' || taskData.task.status === 'paused') {
        // Connect via WebSocket for live streaming
        connectWebSocket(taskId)
      } else {
        // Load historical events from REST API
        const data = await apiFetch<TaskEventsResponse>(`/api/tasks/${taskId}/events`)
        taskInfo.value = data.task
        events.value = normalizeRestEvents(data.events)
        loading.value = false
      }
    } catch (err) {
      error.value = (err as Error).message
      loading.value = false
    }
  }

  /**
   * Connect to WebSocket for live task events
   */
  function connectWebSocket(taskId: string) {
    const token = getAccessToken()
    if (!token) {
      error.value = 'Not authenticated'
      loading.value = false
      return
    }

    const apiBase = config.public.apiBase || ''
    // Convert http(s) to ws(s)
    const wsBase = apiBase.replace(/^http/, 'ws')
    const wsUrl = `${wsBase}/ws/task/${taskId}?token=${encodeURIComponent(token)}`

    ws = new WebSocket(wsUrl)
    isLive.value = true

    ws.onopen = () => {
      loading.value = false
    }

    ws.onmessage = (evt: MessageEvent) => {
      try {
        const data = JSON.parse(evt.data as string) as Record<string, unknown>
        handleWsMessage(data)
      } catch {
        // ignore parse errors
      }
    }

    ws.onerror = () => {
      error.value = 'WebSocket connection error'
      loading.value = false
      isLive.value = false
    }

    ws.onclose = () => {
      isLive.value = false
      ws = null
    }
  }

  function handleWsMessage(data: Record<string, unknown>) {
    const type = data.type as string

    switch (type) {
      case 'task_info':
        taskInfo.value = {
          id: (data.taskId as string) ?? taskInfo.value?.id ?? '',
          name: (data.name as string) ?? taskInfo.value?.name ?? '',
          status: (data.status as string) ?? taskInfo.value?.status ?? '',
          prompt: data.prompt as string | undefined,
          resultSummary: data.resultSummary as string | undefined,
          errorMessage: data.errorMessage as string | undefined,
        }
        break

      case 'backlog_start':
      case 'history_start':
        // Control messages, no-op
        break

      case 'backlog_end':
      case 'history_end':
        loading.value = false
        break

      case 'tool_call_start':
        pendingToolCalls.set((data.toolCallId as string) ?? '', data as unknown as TaskEventItem)
        events.value.push(data as unknown as TaskEventItem)
        break

      case 'tool_call_end':
        pendingToolCalls.delete((data.toolCallId as string) ?? '')
        events.value.push(data as unknown as TaskEventItem)
        break

      case 'text_delta':
        events.value.push(data as unknown as TaskEventItem)
        break

      case 'status_change':
        events.value.push(data as unknown as TaskEventItem)
        if (data.status && taskInfo.value) {
          taskInfo.value.status = data.status as string
          // Capture statusMessage as resultSummary/errorMessage for end-of-task display
          if (data.statusMessage) {
            if (data.status === 'completed') {
              taskInfo.value.resultSummary = data.statusMessage as string
            } else if (data.status === 'failed') {
              taskInfo.value.errorMessage = data.statusMessage as string
            }
          }
        }
        break

      case 'error':
        error.value = (data.error as string) ?? 'Unknown error'
        break

      default:
        events.value.push(data as unknown as TaskEventItem)
        break
    }
  }

  /**
   * Normalize REST API events into a consistent format for the viewer
   */
  function normalizeRestEvents(rawEvents: TaskEventItem[]): TaskEventItem[] {
    return rawEvents.map(evt => {
      if (evt.type === 'tool_call') {
        // Convert REST tool_call format to viewer format
        return {
          type: 'tool_call_end' as const,
          timestamp: evt.timestamp,
          toolName: evt.toolName,
          toolArgs: safeParseJson(evt.input),
          toolResult: safeParseJson(evt.output),
          toolIsError: evt.status === 'error',
          durationMs: evt.durationMs,
        }
      }
      if (evt.type === 'message') {
        const meta = evt.metadata as Record<string, unknown> | null
        const thinking = meta?.thinking as string | undefined
        return {
          type: 'text_delta' as const,
          timestamp: evt.timestamp,
          text: evt.content,
          role: evt.role,
          thinking,
        }
      }
      return evt
    })
  }

  /**
   * Disconnect WebSocket and clean up
   */
  function disconnect() {
    if (ws) {
      ws.close()
      ws = null
    }
    isLive.value = false
    pendingToolCalls.clear()
  }

  onUnmounted(() => {
    disconnect()
  })

  return {
    events,
    taskInfo,
    loading,
    error,
    isLive,
    loadTaskEvents,
    disconnect,
  }
}

function safeParseJson(str: string | undefined | null): unknown {
  if (!str) return null
  try {
    return JSON.parse(str)
  } catch {
    return str
  }
}
