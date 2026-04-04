export interface MemoryConsolidationSettings {
  enabled: boolean
  runAtHour: number
  lookbackDays: number
  providerId: string
}

export interface HeartbeatNotificationToggles {
  healthyToDegraded: boolean
  degradedToHealthy: boolean
  degradedToDown: boolean
  healthyToDown: boolean
  downToFallback: boolean
  fallbackToHealthy: boolean
}

export interface HeartbeatSettings {
  fallbackTrigger: 'down' | 'degraded'
  failuresBeforeFallback: number
  recoveryCheckIntervalMinutes: number
  successesBeforeRecovery: number
  notifications: HeartbeatNotificationToggles
}

export interface LoopDetectionSettings {
  enabled: boolean
  method: 'systematic' | 'smart' | 'auto'
  maxConsecutiveFailures: number
  smartProvider: string
  smartCheckInterval: number
}

export interface TasksSettings {
  defaultProvider: string
  maxDurationMinutes: number
  telegramDelivery: string
  loopDetection: LoopDetectionSettings
  statusUpdateIntervalMinutes: number
}

export interface Settings {
  sessionTimeoutMinutes: number
  language: string
  timezone: string
  heartbeatIntervalMinutes: number
  yoloMode: boolean
  batchingDelayMs: number
  uploadRetentionDays: number
  telegramEnabled: boolean
  telegramBotToken: string
  heartbeat: HeartbeatSettings
  memoryConsolidation: MemoryConsolidationSettings
  tasks: TasksSettings
}

export function useSettings() {
  const { apiFetch } = useApi()

  const settings = ref<Settings | null>(null)
  const loading = ref(false)
  const saving = ref(false)
  const error = ref<string | null>(null)
  const successMessage = ref<string | null>(null)

  async function fetchSettings(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      settings.value = await apiFetch<Settings>('/api/settings')
    } catch (err) {
      error.value = (err as Error).message
    } finally {
      loading.value = false
    }
  }

  async function updateSettings(updates: Partial<Settings>): Promise<boolean> {
    saving.value = true
    error.value = null
    successMessage.value = null
    try {
      const result = await apiFetch<Settings & { message: string }>('/api/settings', {
        method: 'PUT',
        body: JSON.stringify(updates),
      })

      settings.value = {
        sessionTimeoutMinutes: result.sessionTimeoutMinutes,
        language: result.language,
        timezone: result.timezone,
        heartbeatIntervalMinutes: result.heartbeatIntervalMinutes,
        yoloMode: result.yoloMode,
        batchingDelayMs: result.batchingDelayMs,
        uploadRetentionDays: result.uploadRetentionDays,
        telegramEnabled: result.telegramEnabled,
        telegramBotToken: result.telegramBotToken,
        heartbeat: result.heartbeat ?? {
          fallbackTrigger: 'down',
          failuresBeforeFallback: 1,
          recoveryCheckIntervalMinutes: 1,
          successesBeforeRecovery: 3,
          notifications: {
            healthyToDegraded: false,
            degradedToHealthy: false,
            degradedToDown: true,
            healthyToDown: true,
            downToFallback: true,
            fallbackToHealthy: true,
          },
        },
        memoryConsolidation: result.memoryConsolidation ?? {
          enabled: false,
          runAtHour: 3,
          lookbackDays: 3,
          providerId: '',
        },
        tasks: result.tasks ?? {
          defaultProvider: '',
          maxDurationMinutes: 60,
          telegramDelivery: 'auto',
          loopDetection: {
            enabled: true,
            method: 'systematic',
            maxConsecutiveFailures: 3,
            smartProvider: '',
            smartCheckInterval: 5,
          },
          statusUpdateIntervalMinutes: 10,
        },
      }
      successMessage.value = 'saved'
      return true
    } catch (err) {
      error.value = (err as Error).message
      return false
    } finally {
      saving.value = false
    }
  }

  function clearMessages() {
    error.value = null
    successMessage.value = null
  }

  return {
    settings,
    loading,
    saving,
    error,
    successMessage,
    fetchSettings,
    updateSettings,
    clearMessages,
  }
}
