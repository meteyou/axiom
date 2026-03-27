interface DailyFile {
  filename: string
  date: string
  size: number
  modifiedAt: string
}

export function useMemory() {
  const { apiFetch } = useApi()

  const loading = ref(false)
  const saving = ref(false)
  const error = ref<string | null>(null)
  const successMessage = ref<string | null>(null)

  async function loadSoul(): Promise<string> {
    loading.value = true
    error.value = null
    try {
      const data = await apiFetch<{ content: string }>('/api/memory/soul')
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
      await apiFetch('/api/memory/soul', {
        method: 'PUT',
        body: JSON.stringify({ content }),
      })
      successMessage.value = 'saved'
      return true
    } catch (err) {
      error.value = (err as Error).message
      return false
    } finally {
      saving.value = false
    }
  }

  async function loadAgents(): Promise<string> {
    loading.value = true
    error.value = null
    try {
      const data = await apiFetch<{ content: string }>('/api/memory/agents')
      return data.content
    } catch (err) {
      error.value = (err as Error).message
      return ''
    } finally {
      loading.value = false
    }
  }

  async function saveAgents(content: string): Promise<boolean> {
    saving.value = true
    error.value = null
    successMessage.value = null
    try {
      await apiFetch('/api/memory/agents', {
        method: 'PUT',
        body: JSON.stringify({ content }),
      })
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
      const data = await apiFetch<{ files: DailyFile[] }>('/api/memory/daily')
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
      const data = await apiFetch<{ content: string }>(`/api/memory/daily/${date}`)
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
      await apiFetch(`/api/memory/daily/${date}`, {
        method: 'PUT',
        body: JSON.stringify({ content }),
      })
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
    loadAgents,
    saveAgents,
    loadDailyFiles,
    loadDailyFile,
    saveDailyFile,
    clearMessages,
  }
}
