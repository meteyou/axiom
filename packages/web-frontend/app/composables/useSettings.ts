export interface MemoryConsolidationSettings {
  enabled: boolean
  runAtHour: number
  lookbackDays: number
  providerId: string
}

export interface FactExtractionSettings {
  enabled: boolean
  providerId: string
  minSessionMessages: number
}

export interface HealthMonitorNotificationToggles {
  healthyToDegraded: boolean
  degradedToHealthy: boolean
  degradedToDown: boolean
  healthyToDown: boolean
  downToFallback: boolean
  fallbackToHealthy: boolean
}

export interface HealthMonitorSettings {
  fallbackTrigger: 'down' | 'degraded'
  failuresBeforeFallback: number
  recoveryCheckIntervalMinutes: number
  successesBeforeRecovery: number
  notifications: HealthMonitorNotificationToggles
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

export interface AgentHeartbeatNightMode {
  enabled: boolean
  startHour: number
  endHour: number
}

export interface AgentHeartbeatSettings {
  enabled: boolean
  intervalMinutes: number
  nightMode: AgentHeartbeatNightMode
}

export interface TtsSettings {
  enabled: boolean
  provider: 'openai' | 'mistral'
  providerId: string
  openaiModel: string
  openaiVoice: string
  openaiInstructions: string
  mistralVoice: string
  responseFormat: string
}

export interface SttRewriteSettings {
  enabled: boolean
  providerId: string
}

export interface SttSettings {
  enabled: boolean
  provider: 'whisper-url' | 'openai' | 'ollama'
  whisperUrl: string
  providerId: string
  openaiModel: string
  ollamaModel: string
  rewrite: SttRewriteSettings
}

export interface Settings {
  sessionTimeoutMinutes: number
  sessionSummaryProviderId: string
  language: string
  timezone: string
  healthMonitorIntervalMinutes: number
  batchingDelayMs: number
  uploadRetentionDays: number
  telegramEnabled: boolean
  telegramBotToken: string
  healthMonitor: HealthMonitorSettings
  memoryConsolidation: MemoryConsolidationSettings
  factExtraction: FactExtractionSettings
  agentHeartbeat: AgentHeartbeatSettings
  tasks: TasksSettings
  tts: TtsSettings
  stt: SttSettings
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
      const result = await apiFetch<Settings>('/api/settings')
      settings.value = {
        ...result,
        sessionSummaryProviderId: result.sessionSummaryProviderId ?? '',
        factExtraction: result.factExtraction ?? {
          enabled: false,
          providerId: '',
          minSessionMessages: 3,
        },
        stt: {
          enabled: result.stt?.enabled ?? false,
          provider: result.stt?.provider ?? 'whisper-url',
          whisperUrl: result.stt?.whisperUrl ?? '',
          providerId: result.stt?.providerId ?? '',
          openaiModel: result.stt?.openaiModel ?? 'whisper-1',
          ollamaModel: result.stt?.ollamaModel ?? '',
          rewrite: {
            enabled: result.stt?.rewrite?.enabled ?? false,
            providerId: result.stt?.rewrite?.providerId ?? '',
          },
        },
      }
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
        sessionSummaryProviderId: result.sessionSummaryProviderId ?? '',
        language: result.language,
        timezone: result.timezone,
        healthMonitorIntervalMinutes: result.healthMonitorIntervalMinutes,
        batchingDelayMs: result.batchingDelayMs,
        uploadRetentionDays: result.uploadRetentionDays,
        telegramEnabled: result.telegramEnabled,
        telegramBotToken: result.telegramBotToken,
        healthMonitor: result.healthMonitor ?? {
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
        factExtraction: result.factExtraction ?? {
          enabled: false,
          providerId: '',
          minSessionMessages: 3,
        },
        agentHeartbeat: result.agentHeartbeat ?? {
          enabled: false,
          intervalMinutes: 60,
          nightMode: {
            enabled: true,
            startHour: 23,
            endHour: 8,
          },
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
        tts: result.tts ?? {
          enabled: false,
          provider: 'openai',
          providerId: '',
          openaiModel: 'gpt-4o-mini-tts',
          openaiVoice: 'nova',
          openaiInstructions: '',
          mistralVoice: '',
          responseFormat: 'mp3',
        },
        stt: {
          enabled: result.stt?.enabled ?? false,
          provider: result.stt?.provider ?? 'whisper-url',
          whisperUrl: result.stt?.whisperUrl ?? '',
          providerId: result.stt?.providerId ?? '',
          openaiModel: result.stt?.openaiModel ?? 'whisper-1',
          ollamaModel: result.stt?.ollamaModel ?? '',
          rewrite: {
            enabled: result.stt?.rewrite?.enabled ?? false,
            providerId: result.stt?.rewrite?.providerId ?? '',
          },
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
