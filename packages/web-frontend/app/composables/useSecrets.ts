export interface SecretEntry {
  key: string
  configured: boolean
  maskedValue: string
}

export type SecretsScope = 'global' | 'personal'

export function useSecrets() {
  const { apiFetch } = useApi()

  const secrets = ref<SecretEntry[]>([])
  const globalSecrets = ref<SecretEntry[]>([])
  const scope = ref<SecretsScope | null>(null)
  const loading = ref(false)
  const saving = ref(false)
  const error = ref<string | null>(null)
  const successMessage = ref<string | null>(null)

  async function fetchSecrets(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const result = await apiFetch<{ scope: SecretsScope; secrets: SecretEntry[]; globalSecrets?: SecretEntry[] }>('/api/secrets')
      scope.value = result.scope
      secrets.value = result.secrets
      globalSecrets.value = result.globalSecrets ?? []
    } catch (err) {
      error.value = (err as Error).message
    } finally {
      loading.value = false
    }
  }

  async function updateSecrets(updates: Record<string, string>): Promise<boolean> {
    saving.value = true
    error.value = null
    successMessage.value = null
    try {
      const result = await apiFetch<{ message: string; secrets: SecretEntry[] }>('/api/secrets', {
        method: 'PUT',
        body: JSON.stringify({ secrets: updates }),
      })
      secrets.value = result.secrets
      successMessage.value = 'saved'
      return true
    } catch (err) {
      error.value = (err as Error).message
      return false
    } finally {
      saving.value = false
    }
  }

  async function removeSecret(key: string): Promise<boolean> {
    saving.value = true
    error.value = null
    successMessage.value = null
    try {
      const result = await apiFetch<{ message: string; secrets: SecretEntry[] }>(`/api/secrets/${key}`, {
        method: 'DELETE',
      })
      secrets.value = result.secrets
      successMessage.value = 'deleted'
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
    secrets,
    globalSecrets,
    scope,
    loading,
    saving,
    error,
    successMessage,
    fetchSecrets,
    updateSecrets,
    removeSecret,
    clearMessages,
  }
}
