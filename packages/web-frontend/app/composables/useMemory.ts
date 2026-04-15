import type { MemoryDailyFile, MemoryProjectFile } from '~/api/memory'
import { useMemoryApi } from '~/api/memory'

type DailyFile = MemoryDailyFile
type ProjectFile = MemoryProjectFile

export function useMemory() {
  const memoryApi = useMemoryApi()

  const loading = ref(false)
  const saving = ref(false)
  const error = ref<string | null>(null)
  const successMessage = ref<string | null>(null)

  async function loadSoul(): Promise<string> {
    loading.value = true
    error.value = null
    try {
      const data = await memoryApi.getSoul()
      return data.content
    } catch (err) {
      error.value = (err as Error).message
      return ''
    } finally {
      loading.value = false
    }
  }

  async function saveSoul(content: string): Promise<boolean> {
    saving.value = true
    error.value = null
    successMessage.value = null
    try {
      await memoryApi.updateSoul(content)
      successMessage.value = 'saved'
      return true
    } catch (err) {
      error.value = (err as Error).message
      return false
    } finally {
      saving.value = false
    }
  }

  async function loadCoreMemory(): Promise<string> {
    loading.value = true
    error.value = null
    try {
      const data = await memoryApi.getCoreMemory()
      return data.content
    } catch (err) {
      error.value = (err as Error).message
      return ''
    } finally {
      loading.value = false
    }
  }

  async function saveCoreMemory(content: string): Promise<boolean> {
    saving.value = true
    error.value = null
    successMessage.value = null
    try {
      await memoryApi.updateCoreMemory(content)
      successMessage.value = 'saved'
      return true
    } catch (err) {
      error.value = (err as Error).message
      return false
    } finally {
      saving.value = false
    }
  }

  async function loadDailyFiles(): Promise<DailyFile[]> {
    loading.value = true
    error.value = null
    try {
      const data = await memoryApi.listDailyFiles()
      return data.files
    } catch (err) {
      error.value = (err as Error).message
      return []
    } finally {
      loading.value = false
    }
  }

  async function loadDailyFile(date: string): Promise<string> {
    loading.value = true
    error.value = null
    try {
      const data = await memoryApi.getDailyFile(date)
      return data.content
    } catch (err) {
      error.value = (err as Error).message
      return ''
    } finally {
      loading.value = false
    }
  }

  async function saveDailyFile(date: string, content: string): Promise<boolean> {
    saving.value = true
    error.value = null
    successMessage.value = null
    try {
      await memoryApi.updateDailyFile(date, content)
      successMessage.value = 'saved'
      return true
    } catch (err) {
      error.value = (err as Error).message
      return false
    } finally {
      saving.value = false
    }
  }

  async function loadAgentRules(): Promise<string> {
    loading.value = true
    error.value = null
    try {
      const data = await memoryApi.getAgentRules()
      return data.content
    } catch (err) {
      error.value = (err as Error).message
      return ''
    } finally {
      loading.value = false
    }
  }

  async function saveAgentRules(content: string): Promise<boolean> {
    saving.value = true
    error.value = null
    successMessage.value = null
    try {
      await memoryApi.updateAgentRules(content)
      successMessage.value = 'saved'
      return true
    } catch (err) {
      error.value = (err as Error).message
      return false
    } finally {
      saving.value = false
    }
  }

  async function loadDefaultAgentRules(): Promise<string> {
    loading.value = true
    error.value = null
    try {
      const data = await memoryApi.getDefaultAgentRules()
      return data.content
    } catch (err) {
      error.value = (err as Error).message
      return ''
    } finally {
      loading.value = false
    }
  }

  async function loadHeartbeat(): Promise<string> {
    loading.value = true
    error.value = null
    try {
      const data = await memoryApi.getHeartbeat()
      return data.content
    } catch (err) {
      error.value = (err as Error).message
      return ''
    } finally {
      loading.value = false
    }
  }

  async function saveHeartbeat(content: string): Promise<boolean> {
    saving.value = true
    error.value = null
    successMessage.value = null
    try {
      await memoryApi.updateHeartbeat(content)
      successMessage.value = 'saved'
      return true
    } catch (err) {
      error.value = (err as Error).message
      return false
    } finally {
      saving.value = false
    }
  }

  async function loadDefaultHeartbeat(): Promise<string> {
    loading.value = true
    error.value = null
    try {
      const data = await memoryApi.getDefaultHeartbeat()
      return data.content
    } catch (err) {
      error.value = (err as Error).message
      return ''
    } finally {
      loading.value = false
    }
  }

  async function loadConsolidationRules(): Promise<string> {
    loading.value = true
    error.value = null
    try {
      const data = await memoryApi.getConsolidationRules()
      return data.content
    } catch (err) {
      error.value = (err as Error).message
      return ''
    } finally {
      loading.value = false
    }
  }

  async function saveConsolidationRules(content: string): Promise<boolean> {
    saving.value = true
    error.value = null
    successMessage.value = null
    try {
      await memoryApi.updateConsolidationRules(content)
      successMessage.value = 'saved'
      return true
    } catch (err) {
      error.value = (err as Error).message
      return false
    } finally {
      saving.value = false
    }
  }

  async function loadDefaultConsolidationRules(): Promise<string> {
    loading.value = true
    error.value = null
    try {
      const data = await memoryApi.getDefaultConsolidationRules()
      return data.content
    } catch (err) {
      error.value = (err as Error).message
      return ''
    } finally {
      loading.value = false
    }
  }

  async function loadProfile(): Promise<{ content: string; username: string }> {
    loading.value = true
    error.value = null
    try {
      const data = await memoryApi.getProfile()
      return { content: data.content, username: data.username }
    } catch (err) {
      error.value = (err as Error).message
      return { content: '', username: '' }
    } finally {
      loading.value = false
    }
  }

  async function saveProfile(content: string): Promise<boolean> {
    saving.value = true
    error.value = null
    successMessage.value = null
    try {
      await memoryApi.updateProfile(content)
      successMessage.value = 'saved'
      return true
    } catch (err) {
      error.value = (err as Error).message
      return false
    } finally {
      saving.value = false
    }
  }

  async function loadProjectFiles(): Promise<ProjectFile[]> {
    loading.value = true
    error.value = null
    try {
      const data = await memoryApi.listProjectFiles()
      return data.files
    } catch (err) {
      error.value = (err as Error).message
      return []
    } finally {
      loading.value = false
    }
  }

  async function loadProjectFile(name: string): Promise<string> {
    loading.value = true
    error.value = null
    try {
      const data = await memoryApi.getProjectFile(name)
      return data.content
    } catch (err) {
      error.value = (err as Error).message
      return ''
    } finally {
      loading.value = false
    }
  }

  async function saveProjectFile(name: string, content: string): Promise<boolean> {
    saving.value = true
    error.value = null
    successMessage.value = null
    try {
      await memoryApi.updateProjectFile(name, content)
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
    loading,
    saving,
    error,
    successMessage,
    loadSoul,
    saveSoul,
    loadCoreMemory,
    saveCoreMemory,
    loadAgentRules,
    saveAgentRules,
    loadDefaultAgentRules,
    loadHeartbeat,
    saveHeartbeat,
    loadDefaultHeartbeat,
    loadConsolidationRules,
    saveConsolidationRules,
    loadDefaultConsolidationRules,
    loadProfile,
    saveProfile,
    loadDailyFiles,
    loadDailyFile,
    saveDailyFile,
    loadProjectFiles,
    loadProjectFile,
    saveProjectFile,
    clearMessages,
  }
}
