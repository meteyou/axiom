import crypto from 'node:crypto'
import {
  addOAuthProvider,
  addProvider as addProviderConfig,
  clearFallbackProvider,
  deleteProvider as deleteProviderConfig,
  getAvailableModels,
  getFallbackModelId,
  loadProviders,
  loadProvidersDecrypted,
  loadProvidersMasked,
  performProviderHealthCheck,
  PROVIDER_TYPE_PRESETS,
  setActiveProvider,
  setFallbackProvider,
  updateOAuthCredentials,
  updateProvider as updateProviderConfig,
  updateProviderStatus,
} from '@axiom/core'
import type { AvailableModel, ProviderConfig, ProviderType, ProvidersFile } from '@axiom/core'
import type {
  OAuthLoginResponseContract,
  ProviderCreatePayloadContract,
  ProviderFallbackUpdatePayloadContract,
  ProviderModelSelectionPayloadContract,
  ProviderOAuthLoginStartPayloadContract,
  ProviderUpdatePayloadContract,
} from '@axiom/core/contracts'
import { getOAuthProvider } from '@mariozechner/pi-ai/oauth'
import type { OAuthCredentials } from '@mariozechner/pi-ai/oauth'
import {
  normalizeOllamaBaseUrl,
  OLLAMA_REQUEST_TIMEOUT_MS,
  validateOllamaUrl,
} from './schema.js'
import type {
  OllamaTagsResponse,
  PendingOAuthLogin,
  ProvidersRouterOptions,
} from './types.js'

export class ProvidersValidationError extends Error {}
export class ProvidersNotFoundError extends Error {}
export class ProvidersRuntimeError extends Error {}
export class ProvidersExternalError extends Error {}

export interface ProvidersService {
  listProviders: () => { masked: ProvidersFile; decrypted: ProvidersFile }
  getModelsByProviderType: (providerType: string) => AvailableModel[]
  setFallback: (payload: ProviderFallbackUpdatePayloadContract) => { fallbackProvider: string | null; fallbackModel: string | null }
  startOAuthLogin: (payload: ProviderOAuthLoginStartPayloadContract) => Promise<OAuthLoginResponseContract>
  getOAuthStatus: (loginId: string) => Promise<
    | { status: 'pending' }
    | { status: 'error'; error?: string }
    | { status: 'completed'; provider: ProviderConfig }
  >
  submitOAuthCode: (loginId: string, code: string) => void
  createProvider: (payload: ProviderCreatePayloadContract) => ProviderConfig
  updateProvider: (id: string, payload: ProviderUpdatePayloadContract) => ProviderConfig
  deleteProvider: (id: string) => void
  testProvider: (
    id: string,
    payload: ProviderModelSelectionPayloadContract,
  ) => Promise<{
    success: boolean
    message?: string
    error?: string
    latencyMs?: number
    status?: string
    modelId: string
  }>
  activateProvider: (id: string, payload: ProviderModelSelectionPayloadContract) => { activeProvider: string; activeModel: string | null }
  probeOllamaModels: (baseUrl: string) => Promise<OllamaTagsResponse>
  listOllamaModels: (providerId: string) => Promise<OllamaTagsResponse>
  requestOllamaProbePull: (baseUrl: string, modelName: string, signal: AbortSignal) => Promise<Response>
  requestOllamaPull: (providerId: string, modelName: string, signal: AbortSignal) => Promise<Response>
  deleteOllamaModel: (providerId: string, modelName: string) => Promise<void>
}

export function createProvidersService(options: ProvidersRouterOptions = {}): ProvidersService {
  const pendingOAuthLogins = new Map<string, PendingOAuthLogin>()
  let oauthCleanupInterval: ReturnType<typeof setInterval> | null = null

  function stopOAuthCleanupTimer(): void {
    if (!oauthCleanupInterval) return
    clearInterval(oauthCleanupInterval)
    oauthCleanupInterval = null
  }

  function maybeStopOAuthCleanupTimer(): void {
    if (pendingOAuthLogins.size === 0) {
      stopOAuthCleanupTimer()
    }
  }

  function ensureOAuthCleanupTimer(): void {
    if (oauthCleanupInterval) return

    oauthCleanupInterval = setInterval(() => {
      const cutoff = Date.now() - 10 * 60 * 1000
      for (const [id, login] of pendingOAuthLogins) {
        if (login.createdAt < cutoff) {
          pendingOAuthLogins.delete(id)
        }
      }

      maybeStopOAuthCleanupTimer()
    }, 60 * 1000)

    oauthCleanupInterval.unref?.()
  }

  function listProviders() {
    return {
      masked: loadProvidersMasked(),
      decrypted: loadProvidersDecrypted(),
    }
  }

  function getModelsByProviderType(providerType: string): AvailableModel[] {
    try {
      return getAvailableModels(providerType as ProviderType)
    } catch (err) {
      throw new ProvidersRuntimeError(`Failed to get models: ${(err as Error).message}`)
    }
  }

  function setFallback(payload: ProviderFallbackUpdatePayloadContract) {
    try {
      if (payload.providerId === null || payload.providerId === undefined) {
        clearFallbackProvider()
        options.onFallbackProviderChanged?.()
        return {
          fallbackProvider: null,
          fallbackModel: null,
        }
      }

      setFallbackProvider(payload.providerId, payload.modelId ?? undefined)
      options.onFallbackProviderChanged?.()

      return {
        fallbackProvider: payload.providerId,
        fallbackModel: getFallbackModelId(),
      }
    } catch (err) {
      const message = (err as Error).message
      if (message.includes('not found')) {
        throw new ProvidersNotFoundError(message)
      }
      throw new ProvidersValidationError(message)
    }
  }

  async function startOAuthLogin(payload: ProviderOAuthLoginStartPayloadContract): Promise<OAuthLoginResponseContract> {
    const preset = PROVIDER_TYPE_PRESETS[payload.providerType as ProviderType]
    if (preset.authMethod !== 'oauth' || !preset.oauthProviderId) {
      throw new ProvidersValidationError('This provider type does not use OAuth')
    }

    const oauthProvider = getOAuthProvider(preset.oauthProviderId)
    if (!oauthProvider) {
      throw new ProvidersValidationError(`OAuth provider "${preset.oauthProviderId}" not found`)
    }

    const loginId = crypto.randomUUID()
    const loginState: PendingOAuthLogin = {
      status: 'pending',
      providerType: payload.providerType,
      name: payload.name,
      defaultModel: payload.defaultModel,
      createdAt: Date.now(),
      existingProviderId: payload.providerId,
    }
    pendingOAuthLogins.set(loginId, loginState)
    ensureOAuthCleanupTimer()

    let resolveAuthInfo!: (info: { url: string; instructions?: string }) => void
    const authInfoPromise = new Promise<{ url: string; instructions?: string }>((resolve) => {
      resolveAuthInfo = resolve
    })

    oauthProvider
      .login({
        onAuth: (info) => {
          loginState.authUrl = info.url
          loginState.instructions = info.instructions
          resolveAuthInfo(info)
        },
        onPrompt: async (prompt) => {
          if (prompt.allowEmpty) return ''
          return prompt.placeholder ?? ''
        },
        onProgress: () => {},
        onManualCodeInput: oauthProvider.usesCallbackServer
          ? () =>
              new Promise<string>((resolve) => {
                loginState.resolveManualCode = resolve
              })
          : undefined,
      })
      .then((credentials: OAuthCredentials) => {
        loginState.status = 'completed'
        loginState.credentials = credentials
      })
      .catch((err: unknown) => {
        loginState.status = 'error'
        loginState.error = (err as Error).message
        resolveAuthInfo({ url: '', instructions: '' })
      })

    const authInfo = await authInfoPromise

    if (loginState.status === 'error') {
      pendingOAuthLogins.delete(loginId)
      maybeStopOAuthCleanupTimer()
      throw new ProvidersRuntimeError(loginState.error ?? 'OAuth login failed')
    }

    return {
      loginId,
      authUrl: authInfo.url,
      instructions: authInfo.instructions,
      usesCallbackServer: oauthProvider.usesCallbackServer ?? false,
    }
  }

  async function getOAuthStatus(loginId: string): Promise<
    | { status: 'pending' }
    | { status: 'error'; error?: string }
    | { status: 'completed'; provider: ProviderConfig }
  > {
    const loginState = pendingOAuthLogins.get(loginId)
    if (!loginState) {
      throw new ProvidersNotFoundError('Login session not found or expired')
    }

    if (loginState.status === 'completed' && loginState.credentials) {
      try {
        let provider: ProviderConfig

        if (loginState.existingProviderId) {
          updateOAuthCredentials(loginState.existingProviderId, loginState.credentials)
          const file = loadProviders()
          const existing = file.providers.find((entry) => entry.id === loginState.existingProviderId)
          if (!existing) {
            throw new ProvidersNotFoundError('Provider not found')
          }
          provider = existing
        } else {
          const beforeActiveProvider = loadProviders().activeProvider ?? null
          provider = addOAuthProvider({
            name: loginState.name,
            providerType: loginState.providerType as ProviderType,
            defaultModel: loginState.defaultModel,
            oauthCredentials: loginState.credentials,
          })
          const afterActiveProvider = loadProviders().activeProvider ?? null

          if (beforeActiveProvider !== afterActiveProvider) {
            options.onActiveProviderChanged?.()
          }
        }

        pendingOAuthLogins.delete(loginId)
        maybeStopOAuthCleanupTimer()

        return {
          status: 'completed',
          provider,
        }
      } catch (err) {
        throw new ProvidersValidationError((err as Error).message)
      }
    }

    if (loginState.status === 'error') {
      pendingOAuthLogins.delete(loginId)
      maybeStopOAuthCleanupTimer()
      return {
        status: 'error',
        error: loginState.error,
      }
    }

    return { status: 'pending' }
  }

  function submitOAuthCode(loginId: string, code: string): void {
    const loginState = pendingOAuthLogins.get(loginId)
    if (!loginState) {
      throw new ProvidersNotFoundError('Login session not found or expired')
    }

    if (!loginState.resolveManualCode) {
      throw new ProvidersValidationError('This login flow does not accept manual code input')
    }

    loginState.resolveManualCode(code)
  }

  function createProvider(payload: ProviderCreatePayloadContract): ProviderConfig {
    try {
      const beforeActiveProvider = loadProviders().activeProvider ?? null

      const provider = addProviderConfig({
        name: payload.name,
        providerType: payload.providerType as ProviderType,
        baseUrl: payload.baseUrl,
        apiKey: payload.apiKey,
        defaultModel: payload.defaultModel,
        enabledModels: payload.enabledModels,
        degradedThresholdMs: payload.degradedThresholdMs,
      })

      const afterActiveProvider = loadProviders().activeProvider ?? null
      if (beforeActiveProvider !== afterActiveProvider) {
        options.onActiveProviderChanged?.()
      }

      return provider
    } catch (err) {
      throw new ProvidersValidationError((err as Error).message)
    }
  }

  function updateProvider(id: string, payload: ProviderUpdatePayloadContract): ProviderConfig {
    try {
      const activeProvider = loadProviders().activeProvider ?? null
      const provider = updateProviderConfig(id, {
        name: payload.name,
        providerType: payload.providerType as ProviderType | undefined,
        baseUrl: payload.baseUrl,
        apiKey: payload.apiKey,
        defaultModel: payload.defaultModel,
        enabledModels: payload.enabledModels,
        degradedThresholdMs: payload.degradedThresholdMs,
      })

      if (activeProvider === id) {
        options.onActiveProviderChanged?.()
      }

      return provider
    } catch (err) {
      const message = (err as Error).message
      if (message.includes('not found')) {
        throw new ProvidersNotFoundError(message)
      }
      throw new ProvidersValidationError(message)
    }
  }

  function deleteProvider(id: string): void {
    try {
      deleteProviderConfig(id)
    } catch (err) {
      const message = (err as Error).message
      if (message.includes('not found')) {
        throw new ProvidersNotFoundError(message)
      }
      throw new ProvidersValidationError(message)
    }
  }

  async function testProvider(
    id: string,
    payload: ProviderModelSelectionPayloadContract,
  ): Promise<{
    success: boolean
    message?: string
    error?: string
    latencyMs?: number
    status?: string
    modelId: string
  }> {
    const data = loadProvidersDecrypted()
    const provider = data.providers.find((entry) => entry.id === id)
    if (!provider) {
      throw new ProvidersNotFoundError('Provider not found')
    }

    const modelId = payload.modelId
    const testProviderConfig = modelId ? { ...provider, defaultModel: modelId } : provider
    const testModelId = modelId ?? provider.defaultModel

    const result = await performProviderHealthCheck(testProviderConfig)
    const status = result.status === 'down' ? 'error' : 'connected'
    updateProviderStatus(id, status, modelId)

    if (result.status === 'down') {
      return {
        success: false,
        error: result.errorMessage ?? 'Connection failed',
        modelId: testModelId,
      }
    }

    return {
      success: true,
      message:
        result.status === 'degraded'
          ? `Connected, but slow response (${result.latencyMs}ms)`
          : `Connected successfully. Model: ${testModelId}`,
      latencyMs: result.latencyMs ?? undefined,
      status: result.status,
      modelId: testModelId,
    }
  }

  function activateProvider(id: string, payload: ProviderModelSelectionPayloadContract) {
    try {
      const before = loadProviders()
      const beforeActiveProvider = before.activeProvider ?? null
      const beforeActiveModel = before.activeModel ?? null

      setActiveProvider(id, payload.modelId ?? undefined)

      const after = loadProviders()
      const afterActiveProvider = after.activeProvider ?? null
      const afterActiveModel = after.activeModel ?? null

      if (beforeActiveProvider !== afterActiveProvider || beforeActiveModel !== afterActiveModel) {
        options.onActiveProviderChanged?.()
      }

      return {
        activeProvider: id,
        activeModel: afterActiveModel,
      }
    } catch (err) {
      const message = (err as Error).message
      if (message.includes('not found')) {
        throw new ProvidersNotFoundError(message)
      }
      throw new ProvidersValidationError(message)
    }
  }

  async function probeOllamaModels(baseUrl: string): Promise<OllamaTagsResponse> {
    const ollamaBase = normalizeOllamaBaseUrl(baseUrl)
    validateOllamaUrl(ollamaBase)

    const tagsResp = await fetch(`${ollamaBase}/api/tags`, {
      signal: AbortSignal.timeout(OLLAMA_REQUEST_TIMEOUT_MS),
    })

    if (!tagsResp.ok) {
      throw new ProvidersExternalError(`Ollama returned HTTP ${tagsResp.status}`)
    }

    return (await tagsResp.json()) as OllamaTagsResponse
  }

  async function listOllamaModels(providerId: string): Promise<OllamaTagsResponse> {
    const provider = requireProvider(providerId)
    if (provider.providerType !== 'ollama') {
      throw new ProvidersValidationError('Not an Ollama provider')
    }

    return probeOllamaModels(provider.baseUrl || 'http://localhost:11434')
  }

  async function requestOllamaProbePull(baseUrl: string, modelName: string, signal: AbortSignal): Promise<Response> {
    const ollamaBase = normalizeOllamaBaseUrl(baseUrl)
    validateOllamaUrl(ollamaBase)

    return requestOllamaPullFromBase(ollamaBase, modelName, signal)
  }

  async function requestOllamaPull(providerId: string, modelName: string, signal: AbortSignal): Promise<Response> {
    const provider = requireProvider(providerId)
    if (provider.providerType !== 'ollama') {
      throw new ProvidersValidationError('Not an Ollama provider')
    }

    const ollamaBase = normalizeOllamaBaseUrl(provider.baseUrl || 'http://localhost:11434')
    validateOllamaUrl(ollamaBase)

    return requestOllamaPullFromBase(ollamaBase, modelName, signal)
  }

  async function deleteOllamaModel(providerId: string, modelName: string): Promise<void> {
    const provider = requireProvider(providerId)
    if (provider.providerType !== 'ollama') {
      throw new ProvidersValidationError('Not an Ollama provider')
    }

    const ollamaBase = normalizeOllamaBaseUrl(provider.baseUrl || 'http://localhost:11434')
    validateOllamaUrl(ollamaBase)

    const deleteResponse = await fetch(`${ollamaBase}/api/delete`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: modelName }),
      signal: AbortSignal.timeout(OLLAMA_REQUEST_TIMEOUT_MS),
    })

    if (!deleteResponse.ok) {
      const errorText = await deleteResponse.text().catch(() => '')
      throw new ProvidersExternalError(`Ollama delete failed: HTTP ${deleteResponse.status} ${errorText}`)
    }
  }

  return {
    listProviders,
    getModelsByProviderType,
    setFallback,
    startOAuthLogin,
    getOAuthStatus,
    submitOAuthCode,
    createProvider,
    updateProvider,
    deleteProvider,
    testProvider,
    activateProvider,
    probeOllamaModels,
    listOllamaModels,
    requestOllamaProbePull,
    requestOllamaPull,
    deleteOllamaModel,
  }
}

async function requestOllamaPullFromBase(
  ollamaBase: string,
  modelName: string,
  signal: AbortSignal,
): Promise<Response> {
  const pullResponse = await fetch(`${ollamaBase}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: modelName, stream: true }),
    signal,
  })

  if (!pullResponse.ok) {
    const errorText = await pullResponse.text().catch(() => '')
    throw new ProvidersExternalError(`Ollama pull failed: HTTP ${pullResponse.status} ${errorText}`)
  }

  return pullResponse
}

function requireProvider(providerId: string): ProviderConfig {
  const data = loadProvidersDecrypted()
  const provider = data.providers.find((entry) => entry.id === providerId)
  if (!provider) {
    throw new ProvidersNotFoundError('Provider not found')
  }

  return provider
}
