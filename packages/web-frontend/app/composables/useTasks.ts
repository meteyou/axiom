export interface Task {
  id: string
  name: string
  prompt: string
  status: 'running' | 'paused' | 'completed' | 'failed'
  triggerType: 'user' | 'agent' | 'cronjob'
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

interface TasksResponse {
  tasks: Task[]
  pagination: {
    page: number
    limit: number
    total: number
    totalPages: number
  }
}

interface TaskResponse {
  task: Task
}

export function useTasks() {
  const { apiFetch } = useApi()

  const tasks = ref<Task[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)
  const pagination = ref({
    page: 1,
    limit: 20,
    total: 0,
    totalPages: 0,
  })

  const filters = reactive({
    status: '' as string,
    triggerType: '' as string,
  })

  // Sort state
  const sortField = ref<string>('createdAt')
  const sortDirection = ref<'asc' | 'desc'>('desc')

  // Polling
  let pollTimer: ReturnType<typeof setInterval> | null = null

  const hasRunningTasks = computed(() =>
    tasks.value.some(t => t.status === 'running')
  )

  async function loadTasks(page: number = 1, { silent = false }: { silent?: boolean } = {}) {
    if (!silent) {
      loading.value = true
    }
    error.value = null

    try {
      const params = new URLSearchParams()
      params.set('page', String(page))
      params.set('limit', String(pagination.value.limit))
      if (filters.status) params.set('status', filters.status)
      if (filters.triggerType) params.set('trigger_type', filters.triggerType)

      const data = await apiFetch<TasksResponse>(`/api/tasks?${params.toString()}`)
      tasks.value = data.tasks
      pagination.value = data.pagination
    } catch (err) {
      if (!silent) {
        error.value = (err as Error).message
      }
    } finally {
      if (!silent) {
        loading.value = false
      }
    }
  }

  async function killTask(id: string): Promise<boolean> {
    try {
      await apiFetch<TaskResponse>(`/api/tasks/${id}/kill`, { method: 'POST' })
      // Reload tasks to get updated status
      await loadTasks(pagination.value.page)
      return true
    } catch (err) {
      error.value = (err as Error).message
      return false
    }
  }

  function sortBy(field: string) {
    if (sortField.value === field) {
      sortDirection.value = sortDirection.value === 'asc' ? 'desc' : 'asc'
    } else {
      sortField.value = field
      sortDirection.value = field === 'createdAt' ? 'desc' : 'asc'
    }
  }

  const sortedTasks = computed(() => {
    const field = sortField.value
    const dir = sortDirection.value === 'asc' ? 1 : -1

    return [...tasks.value].sort((a, b) => {
      const aVal: unknown = (a as Record<string, unknown>)[field]
      const bVal: unknown = (b as Record<string, unknown>)[field]

      // Handle null values
      if (aVal == null && bVal == null) return 0
      if (aVal == null) return 1
      if (bVal == null) return -1

      // Handle numeric fields
      if (typeof aVal === 'number' && typeof bVal === 'number') {
        return (aVal - bVal) * dir
      }

      // Handle string/date fields
      return String(aVal).localeCompare(String(bVal)) * dir
    })
  })

  function startPolling(intervalMs: number = 5000) {
    stopPolling()
    pollTimer = setInterval(() => {
      // Only poll if there are running tasks or on first loads
      if (hasRunningTasks.value || tasks.value.length === 0) {
        loadTasks(pagination.value.page, { silent: true })
      }
    }, intervalMs)
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  return {
    tasks,
    sortedTasks,
    loading,
    error,
    pagination,
    filters,
    sortField,
    sortDirection,
    hasRunningTasks,
    loadTasks,
    killTask,
    sortBy,
    startPolling,
    stopPolling,
  }
}
