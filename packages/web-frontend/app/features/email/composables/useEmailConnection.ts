import type { EmailConnectionPayload, EmailConnectionTestResult, EmailFolder } from '~/api/email'
import { useEmailApi } from '~/api/email'

export function useEmailConnection() {
  const emailApi = useEmailApi()

  const testing = ref(false)
  const testResult = ref<EmailConnectionTestResult | null>(null)
  const testError = ref<string | null>(null)

  const folders = ref<EmailFolder[]>([])
  const foldersLoading = ref(false)
  const foldersError = ref<string | null>(null)

  async function testConnection(payload: EmailConnectionPayload): Promise<boolean> {
    testing.value = true
    testError.value = null
    testResult.value = null
    try {
      const result = await emailApi.testConnection(payload)
      testResult.value = result
      return result.ok
    } catch (err) {
      testError.value = (err as Error).message
      return false
    } finally {
      testing.value = false
    }
  }

  async function loadFolders(payload: EmailConnectionPayload): Promise<boolean> {
    foldersLoading.value = true
    foldersError.value = null
    try {
      const data = await emailApi.listFolders(payload)
      folders.value = data.folders
      return true
    } catch (err) {
      foldersError.value = (err as Error).message
      folders.value = []
      return false
    } finally {
      foldersLoading.value = false
    }
  }

  function reset(): void {
    testResult.value = null
    testError.value = null
    folders.value = []
    foldersError.value = null
  }

  return {
    testing,
    testResult,
    testError,
    testConnection,
    folders,
    foldersLoading,
    foldersError,
    loadFolders,
    reset,
  }
}
