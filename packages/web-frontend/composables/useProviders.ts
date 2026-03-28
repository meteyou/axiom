export interface Provider {
  id: string
  name: string
  type: string
  providerType: string
  provider: string
  baseUrl: string
  apiKey: string
  apiKeyMasked: string
  defaultModel: string
  degradedThresholdMs?: number
  status?: 'connected' | 'error' | 'untested'
  authMethod?: 'api-key' | 'oauth'
  oauthCredentials?: { expires: number }
  cost?: { input: number; output: number } | null
}

export interface OAuthLoginResponse {
  loginId: string
  authUrl: string
  instructions?: string
  usesCallbackServer: boolean
}

export interface OAuthStatusResponse {
  status: 'pending' | 'completed' | 'error'
  provider?: Provider
  error?: string
}

export interface ProviderTypePreset {
  type: string
  label: string
  apiType: string
  providerName: string
  baseUrl: string
  requiresApiKey: boolean
  urlEditable: boolean
  piAiProvider: string | null
  authMethod: 'api-key' | 'oauth'
  oauthProviderId?: string
}

export interface AvailableModel {
  id: string
  name: string
}

interface ProvidersResponse {
  providers: Provider[]
  activeProvider: string | null
  presets: Record<string, ProviderTypePreset>
}

interface ProviderMutationResponse {
  provider: Provider
}

interface TestResult {
  success: boolean
  message?: string
  error?: string
}

export function useProviders() {
  const { apiFetch } = useApi()

  const providers = useState<Provider[]>('providers_list', () => [])
  const activeProviderId = useState<string | null>('active_provider', () => null)
  const presets = useState<Record<string, ProviderTypePreset>>('provider_presets', () => ({}))
  const loading = useState<boolean>('providers_loading', () => false)
  const error = useState<string | null>('providers_error', () => null)
  const testingId = useState<string | null>('providers_testing', () => null)

  async function fetchProviders(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const data = await apiFetch<ProvidersResponse>('/api/providers')
      providers.value = data.providers
      activeProviderId.value = data.activeProvider
      presets.value = data.presets
    } catch (err) {
      error.value = (err as Error).message
    } finally {
      loading.value = false
    }
  }

  async function addProvider(input: {
    name: string
    providerType: string
    baseUrl?: string
    apiKey?: string
    defaultModel: string
    degradedThresholdMs?: number
  }): Promise<Provider | null> {
    error.value = null
    try {
      const data = await apiFetch<ProviderMutationResponse>('/api/providers', {
        method: 'POST',
        body: JSON.stringify(input),
      })
      await fetchProviders()
      return data.provider
    } catch (err) {
      error.value = (err as Error).message
      return null
    }
  }

  async function updateProvider(id: string, input: {
    name?: string
    providerType?: string
    baseUrl?: string
    apiKey?: string
    defaultModel?: string
    degradedThresholdMs?: number
  }): Promise<Provider | null> {
    error.value = null
    try {
      const data = await apiFetch<ProviderMutationResponse>(`/api/providers/${id}`, {
        method: 'PUT',
        body: JSON.stringify(input),
      })
      await fetchProviders()
      return data.provider
    } catch (err) {
      error.value = (err as Error).message
      return null
    }
  }

  async function deleteProvider(id: string): Promise<boolean> {
    error.value = null
    try {
      await apiFetch(`/api/providers/${id}`, { method: 'DELETE' })
      await fetchProviders()
      return true
    } catch (err) {
      error.value = (err as Error).message
      return false
    }
  }

  async function testProvider(id: string): Promise<TestResult> {
    testingId.value = id
    try {
      const result = await apiFetch<TestResult>(`/api/providers/${id}/test`, {
        method: 'POST',
      })
      await fetchProviders()
      return result
    } catch (err) {
      return { success: false, error: (err as Error).message }
    } finally {
      testingId.value = null
    }
  }

  async function activateProvider(id: string): Promise<boolean> {
    error.value = null
    try {
      await apiFetch(`/api/providers/${id}/activate`, { method: 'POST' })
      activeProviderId.value = id
      return true
    } catch (err) {
      error.value = (err as Error).message
      return false
    }
  }

  async function fetchModels(providerType: string): Promise<AvailableModel[]> {
    try {
      const data = await apiFetch<{ models: AvailableModel[] }>(`/api/providers/models/${providerType}`)
      return data.models
    } catch {
      return []
    }
  }

  async function startOAuthLogin(input: {
    providerType: string
    name: string
    defaultModel: string
  }): Promise<OAuthLoginResponse> {
    return apiFetch<OAuthLoginResponse>('/api/providers/oauth/login', {
      method: 'POST',
      body: JSON.stringify(input),
    })
  }

  async function pollOAuthStatus(loginId: string): Promise<OAuthStatusResponse> {
    return apiFetch<OAuthStatusResponse>(`/api/providers/oauth/status/${loginId}`)
  }

  async function submitOAuthCode(loginId: string, code: string): Promise<void> {
    await apiFetch(`/api/providers/oauth/code/${loginId}`, {
      method: 'POST',
      body: JSON.stringify({ code }),
    })
  }

  return {
    providers,
    activeProviderId,
    presets,
    loading,
    error,
    testingId,
    fetchProviders,
    fetchModels,
    addProvider,
    updateProvider,
    deleteProvider,
    testProvider,
    activateProvider,
    startOAuthLogin,
    pollOAuthStatus,
    submitOAuthCode,
  }
}
