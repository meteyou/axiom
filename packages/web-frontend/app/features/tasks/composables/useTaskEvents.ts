import type { TaskEventItem, TaskInfo } from '~/api/tasks'
import { useTasksApi } from '~/api/tasks'

/**
 * Composable for viewing task events — live via WebSocket or historical via REST API.
 */
export function useTaskEvents() {
  const tasksApi = useTasksApi()
  const { getAccessToken } = useAuth()
  const config = useRuntimeConfig()

  const events = ref<TaskEventItem[]>([])
  const taskInfo = ref<TaskInfo | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)
  const isLive = ref(false)

  let ws: WebSocket | null = null
  // Maps toolCallId -> index in `events.value` so `tool_call_end` can merge
  // into the existing `tool_call_start` entry (same panel, like the chat view).
  const pendingToolCalls = new Map<string, number>()

  const textBuffer = ref('')

  async function loadTaskEvents(taskId: string) {
    loading.value = true
    error.value = null
    events.value = []
    taskInfo.value = null
    textBuffer.value = ''
    pendingToolCalls.clear()

    try {
      const taskData = await tasksApi.getTask(taskId)
      taskInfo.value = taskData.task

      if (taskData.task.status === 'running' || taskData.task.status === 'paused') {
        connectWebSocket(taskId)
      } else {
        const data = await tasksApi.getTaskEvents(taskId)
        taskInfo.value = data.task
        events.value = normalizeRestEvents(data.events)
        loading.value = false
      }
    } catch (err) {
      error.value = (err as Error).message
      loading.value = false
    }
  }

  function connectWebSocket(taskId: string) {
    const token = getAccessToken()
    if (!token) {
      error.value = 'Not authenticated'
      loading.value = false
      return
    }

    const apiBase = config.public.apiBase || ''
    const wsBase = apiBase.replace(/^http/, 'ws')
    const wsUrl = `${wsBase}/ws/task/${taskId}?token=${encodeURIComponent(token)}`

    ws = new WebSocket(wsUrl)
    isLive.value = true

    ws.onopen = () => {
      loading.value = false
    }

    ws.onmessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data as string) as Record<string, unknown>
        handleWsMessage(data)
      } catch {
        // Ignore JSON parse errors from malformed messages.
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
        break

      case 'backlog_end':
      case 'history_end':
        loading.value = false
        break

      case 'tool_call_start': {
        const toolCallId = (data.toolCallId as string) ?? ''
        events.value.push(data as unknown as TaskEventItem)
        if (toolCallId) {
          pendingToolCalls.set(toolCallId, events.value.length - 1)
        }
        break
      }

      case 'tool_call_end': {
        const toolCallId = (data.toolCallId as string) ?? ''
        const existingIdx = toolCallId ? pendingToolCalls.get(toolCallId) : undefined
        const endEvent = data as unknown as TaskEventItem
        if (existingIdx !== undefined && events.value[existingIdx]) {
          // Merge result into the existing start entry so it renders as a
          // single panel with args + result, matching the chat view.
          const existing = events.value[existingIdx]!
          events.value[existingIdx] = {
            ...existing,
            ...endEvent,
            type: 'tool_call_end',
            // Preserve args from start in case end payload omits them.
            toolArgs: endEvent.toolArgs ?? existing.toolArgs,
            toolName: endEvent.toolName ?? existing.toolName,
          }
          pendingToolCalls.delete(toolCallId)
        } else {
          // No matching start (e.g. missed backlog entry) — append as-is.
          events.value.push(endEvent)
        }
        break
      }

      case 'text_delta':
        events.value.push(data as unknown as TaskEventItem)
        break

      case 'status_change':
        events.value.push(data as unknown as TaskEventItem)
        if (data.status && taskInfo.value) {
          taskInfo.value.status = data.status as string
          if (data.statusMessage) {
            if (data.status === 'completed') {
              taskInfo.value.resultSummary = data.statusMessage as string
            } else if (data.status === 'failed') {
              taskInfo.value.errorMessage = data.statusMessage as string
            }
          }
        }
        // The server keeps the socket open after the task ends; close it
        // ourselves so `isLive` reflects the actual task state.
        if (data.status === 'completed' || data.status === 'failed') {
          disconnect()
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

  function normalizeRestEvents(rawEvents: TaskEventItem[]): TaskEventItem[] {
    return rawEvents.map((event) => {
      if (event.type === 'tool_call') {
        return {
          type: 'tool_call_end' as const,
          timestamp: event.timestamp,
          toolName: event.toolName,
          toolArgs: safeParseJson(event.input),
          toolResult: safeParseJson(event.output),
          toolIsError: event.status === 'error',
          durationMs: event.durationMs,
        }
      }

      if (event.type === 'message') {
        const metadata = event.metadata as Record<string, unknown> | null
        const thinking = metadata?.thinking as string | undefined

        return {
          type: 'text_delta' as const,
          timestamp: event.timestamp,
          text: event.content,
          role: event.role,
          thinking,
        }
      }

      return event
    })
  }

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

function safeParseJson(rawValue: string | undefined | null): unknown {
  if (!rawValue) return null

  try {
    return JSON.parse(rawValue)
  } catch {
    return rawValue
  }
}
