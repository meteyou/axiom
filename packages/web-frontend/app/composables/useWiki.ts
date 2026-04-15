import type { MemoryWikiFile } from '~/api/memory'
import { useMemoryApi } from '~/api/memory'

type WikiFile = MemoryWikiFile

export function useWiki() {
  const memoryApi = useMemoryApi()

  const loading = ref(false)
  const saving = ref(false)
  const error = ref<string | null>(null)
  const successMessage = ref<string | null>(null)

  async function loadWikiPages(): Promise<WikiFile[]> {
    loading.value = true
    error.value = null
    try {
      const data = await memoryApi.listWikiPages()
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
      const data = await memoryApi.getWikiPage(name)
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
      await memoryApi.updateWikiPage(name, content)
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
      await memoryApi.deleteWikiPage(name)
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
