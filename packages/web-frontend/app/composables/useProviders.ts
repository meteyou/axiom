import type {
  ProviderContract,
  OAuthLoginResponseContract,
  OAuthStatusResponseContract,
  ProviderTypePresetContract,
  AvailableModelContract,
  OllamaModelContract,
  OllamaPullEventContract,
  ProvidersListResponseContract,
  ProviderMutationResponseContract,
  ProviderTestResultContract,
  ProviderCreatePayloadContract,
  ProviderUpdatePayloadContract,
  ProviderActivationResponseContract,
  ProviderFallbackResponseContract,
} from '@openagent/core/contracts'

export type Provider = ProviderContract
export type OAuthLoginResponse = OAuthLoginResponseContract
export type OAuthStatusResponse = OAuthStatusResponseContract
export type ProviderTypePreset = ProviderTypePresetContract
export type AvailableModel = AvailableModelContract
export type OllamaModel = OllamaModelContract
export type OllamaPullEvent = OllamaPullEventContract

type ProvidersResponse = ProvidersListResponseContract
type ProviderMutationResponse = ProviderMutationResponseContract
type TestResult = ProviderTestResultContract

export function useProviders() {
  const { apiFetch } = useApi()

  const providers = useState<Provider[]>('providers_list', () => [])
  const activeProviderId = useState<string | null>('active_provider', () => null)
  const activeModelId = useState<string | null>('active_model', () => null)
  const fallbackProviderId = useState<string | null>('fallback_provider', () => null)
  const fallbackModelId = useState<string | null>('fallback_model', () => null)
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
      activeModelId.value = data.activeModel
      fallbackProviderId.value = data.fallbackProvider
      fallbackModelId.value = data.fallbackModel
      presets.value = data.presets
    } catch (err) {
      error.value = (err as Error).message
    } finally {
      loading.value = false
    }
  }

  async function addProvider(input: ProviderCreatePayloadContract): Promise<Provider | null> {
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

  async function updateProvider(id: string, input: ProviderUpdatePayloadContract): Promise<Provider | null> {
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

  async function testProvider(id: string, modelId?: string): Promise<TestResult> {
    testingId.value = modelId ? `${id}:${modelId}` : id
    try {
      const result = await apiFetch<TestResult>(`/api/providers/${id}/test`, {
        method: 'POST',
        body: JSON.stringify({ modelId }),
      })
      await fetchProviders()
      return result
    } catch (err) {
      return { success: false, error: (err as Error).message }
    } finally {
      testingId.value = null
    }
  }

  async function activateProvider(id: string, modelId?: string): Promise<boolean> {
    error.value = null
    try {
      const result = await apiFetch<ProviderActivationResponseContract>(
        `/api/providers/${id}/activate`,
        { method: 'POST', body: JSON.stringify({ modelId }) },
      )
      activeProviderId.value = result.activeProvider
      activeModelId.value = result.activeModel
      return true
    } catch (err) {
      error.value = (err as Error).message
      return false
    }
  }

  async function fetchModels(providerType: string): Promise<AvailableModel[]> {
    const data = await apiFetch<{ models: AvailableModel[] }>(`/api/providers/models/${providerType}`)
    return data.models
  }

  async function fetchOllamaModels(providerId: string): Promise<OllamaModel[]> {
    const data = await apiFetch<{ models: OllamaModel[] }>(`/api/providers/${providerId}/ollama-models`)
    return data.models
  }

  /** Probe an Ollama instance by base URL (for create-mode before a provider exists). */
  async function probeOllamaModels(baseUrl: string, providerType: string): Promise<OllamaModel[]> {
    const data = await apiFetch<{ models: OllamaModel[] }>('/api/providers/ollama-probe', {
      method: 'POST',
      body: JSON.stringify({ baseUrl, providerType }),
    })
    return data.models
  }

  async function pullOllamaModel(
    providerId: string,
    modelName: string,
    onProgress: (event: OllamaPullEvent) => void,
  ): Promise<void> {
    const { getAuthHeaders } = useApi()
    const config = useRuntimeConfig()
    const baseUrl = config.public.apiBase || ''
    const url = `${baseUrl}/api/providers/${providerId}/ollama-pull`
    const headers = getAuthHeaders()

    const response = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelName }),
    })

    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: 'Pull failed' }))
      throw new Error((err as { error?: string }).error || `HTTP ${response.status}`)
    }

    await readSSEStream(response, onProgress)
  }

  /** Pull a model via probe endpoint (for create-mode before a provider exists). */
  async function probeOllamaPull(
    baseUrl: string,
    providerType: string,
    modelName: string,
    onProgress: (event: OllamaPullEvent) => void,
  ): Promise<void> {
    const { getAuthHeaders } = useApi()
    const config = useRuntimeConfig()
    const apiBase = config.public.apiBase || ''
    const url = `${apiBase}/api/providers/ollama-probe/pull`
    const headers = getAuthHeaders()

    const response = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl, providerType, modelName }),
    })

    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: 'Pull failed' }))
      throw new Error((err as { error?: string }).error || `HTTP ${response.status}`)
    }

    await readSSEStream(response, onProgress)
  }

  /** Shared helper to consume an SSE stream from Ollama pull endpoints. */
  async function readSSEStream(
    response: Response,
    onProgress: (event: OllamaPullEvent) => void,
  ): Promise<void> {
    const reader = response.body?.getReader()
    if (!reader) throw new Error('No response body')

    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        try {
          const event = JSON.parse(line.slice(6)) as OllamaPullEvent
          onProgress(event)
        } catch {
          console.warn('[ollama-pull] Skipping malformed SSE data:', line.substring(0, 200))
        }
      }
    }
  }

  async function deleteOllamaModel(providerId: string, modelName: string): Promise<void> {
    await apiFetch(`/api/providers/${providerId}/ollama-models/${encodeURIComponent(modelName)}`, {
      method: 'DELETE',
    })
  }

  async function startOAuthLogin(input: {
    providerType: string
    name: string
    defaultModel: string
    providerId?: string
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

  async function setFallbackProvider(providerId: string | null, modelId?: string | null): Promise<boolean> {
    error.value = null
    try {
      const result = await apiFetch<ProviderFallbackResponseContract>(
        '/api/providers/fallback',
        { method: 'PUT', body: JSON.stringify({ providerId, modelId }) },
      )
      fallbackProviderId.value = result.fallbackProvider
      fallbackModelId.value = result.fallbackModel
      return true
    } catch (err) {
      error.value = (err as Error).message
      return false
    }
  }

  return {
    providers,
    activeProviderId,
    activeModelId,
    fallbackProviderId,
    fallbackModelId,
    presets,
    loading,
    error,
    testingId,
    fetchProviders,
    fetchModels,
    fetchOllamaModels,
    probeOllamaModels,
    pullOllamaModel,
    probeOllamaPull,
    deleteOllamaModel,
    addProvider,
    updateProvider,
    deleteProvider,
    testProvider,
    activateProvider,
    setFallbackProvider,
    startOAuthLogin,
    pollOAuthStatus,
    submitOAuthCode,
  }
}
