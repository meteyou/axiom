export interface Settings {
  sessionTimeoutMinutes: number
  language: string
  heartbeatIntervalMinutes: number
  yoloMode: boolean
  batchingDelayMs: number
  telegramBotToken: string
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
        heartbeatIntervalMinutes: result.heartbeatIntervalMinutes,
        yoloMode: result.yoloMode,
        batchingDelayMs: result.batchingDelayMs,
        telegramBotToken: result.telegramBotToken,
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
