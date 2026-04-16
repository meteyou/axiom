import {
  normalizeSettingsContract,
  type SettingsContract,
  type SettingsUpdateContract,
  type MemoryConsolidationSettingsContract,
  type FactExtractionSettingsContract,
  type HealthMonitorNotificationTogglesContract,
  type HealthMonitorSettingsContract,
  type AgentHeartbeatSettingsContract,
  type TasksSettingsContract,
  type TtsSettingsContract,
  type SttSettingsContract,
  type AgentHeartbeatNightModeContract,
} from '@openagent/core/contracts'
import { useSettingsApi } from '~/api/settings'

export type MemoryConsolidationSettings = MemoryConsolidationSettingsContract
export type FactExtractionSettings = FactExtractionSettingsContract
export type HealthMonitorNotificationToggles = HealthMonitorNotificationTogglesContract
export type HealthMonitorSettings = HealthMonitorSettingsContract
export type TasksSettings = TasksSettingsContract
export type AgentHeartbeatNightMode = AgentHeartbeatNightModeContract
export type AgentHeartbeatSettings = AgentHeartbeatSettingsContract
export type TtsSettings = TtsSettingsContract
export type SttSettings = SttSettingsContract
export type Settings = SettingsContract

export function useSettings() {
  const settingsApi = useSettingsApi()

  const settings = ref<Settings | null>(null)
  const loading = ref(false)
  const saving = ref(false)
  const error = ref<string | null>(null)
  const successMessage = ref<string | null>(null)

  async function fetchSettings(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const result = await settingsApi.getSettings()
      settings.value = normalizeSettingsContract(result)
    } catch (err) {
      error.value = (err as Error).message
    } finally {
      loading.value = false
    }
  }

  async function updateSettings(updates: Partial<SettingsUpdateContract>): Promise<boolean> {
    saving.value = true
    error.value = null
    successMessage.value = null
    try {
      const result = await settingsApi.updateSettings(updates)

      settings.value = normalizeSettingsContract(result)
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
