interface WikiFile {
  filename: string
  name: string
  title: string
  aliases: string[]
  size: number
  modifiedAt: string
}

export function useWiki() {
  const { apiFetch } = useApi()

  const loading = ref(false)
  const saving = ref(false)
  const error = ref<string | null>(null)
  const successMessage = ref<string | null>(null)

  async function loadWikiPages(): Promise<WikiFile[]> {
    loading.value = true
    error.value = null
    try {
      const data = await apiFetch<{ files: WikiFile[] }>('/api/memory/wiki')
      return data.files
    } catch (err) {
      error.value = (err as Error).message
      return []
    } finally {
      loading.value = false
    }
  }

  async function loadWikiPage(name: string): Promise<string> {
    loading.value = true
    error.value = null
    try {
      const data = await apiFetch<{ content: string }>(`/api/memory/wiki/${name}`)
      return data.content
    } catch (err) {
      error.value = (err as Error).message
      return ''
    } finally {
      loading.value = false
    }
  }

  async function saveWikiPage(name: string, content: string): Promise<boolean> {
    saving.value = true
    error.value = null
    successMessage.value = null
    try {
      await apiFetch(`/api/memory/wiki/${name}`, {
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

  async function deleteWikiPage(name: string): Promise<boolean> {
    loading.value = true
    error.value = null
    try {
      await apiFetch(`/api/memory/wiki/${name}`, {
        method: 'DELETE',
      })
      return true
    } catch (err) {
      error.value = (err as Error).message
      return false
    } finally {
      loading.value = false
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
    loadWikiPages,
    loadWikiPage,
    saveWikiPage,
    deleteWikiPage,
    clearMessages,
  }
}
