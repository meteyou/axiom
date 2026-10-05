import crypto from 'node:crypto'
import { URL } from 'node:url'
import {
  addOAuthProvider,
  addProvider as addProviderConfig,
  checkImageModelAvailability,
  clearFallbackProvider,
  createImageOnlyModelIdMatcher,
  deleteProvider as deleteProviderConfig,
  getApiKeyForProvider,
  generateImagesWithProvider,
  getAvailableImageModels,
  getAvailableModels,
  getRadiusCatalog,
  getUsableImageModels,
  IMAGE_TEST_PROMPT,
  logTokenUsage,
  isDynamicCatalogProvider,
  isRadiusProviderType,
  refreshPiCatalogs,
  supportsModelSpecOverrides,
  refreshRadiusCatalog,
  radiusCatalogToAvailableModels,
  getFallbackModelId,
  getProviderDefaultModel,
  loadProviders,
  loadProvidersDecrypted,
  loadProvidersMasked,
  performProviderHealthCheck,
  PROVIDER_TYPE_PRESETS,
  resetDisabledProviderReferences,
  ScheduledTaskStore,
  setActiveProvider,
  setFallbackProvider,
  setProviderDisabled,
  setProviderModelDisabled,
  updateOAuthCredentials,
  updateProvider as updateProviderConfig,
  updateProviderModel as updateProviderModelConfig,
  updateProviderStatus,
  ProviderNotFoundError,
} from '@axiom/core'
import type { AvailableImageModel, AvailableModel, ProviderConfig, ProviderType, ProvidersFile } from '@axiom/core'
import type {
  OAuthLoginResponseContract,
  ProviderImageTestResultContract,
  ProviderCatalogRefreshResultContract,
  ProviderCreatePayloadContract,
  ProviderFallbackUpdatePayloadContract,
  ProviderModelSelectionPayloadContract,
  ProviderModelUpdatePayloadContract,
  ProviderOAuthLoginStartPayloadContract,
  ProviderUpdatePayloadContract,
} from '@axiom/core/contracts'
import { getOAuthAuth, oauthLogin } from '@axiom/core'
import type { OAuthCredentials } from '@earendil-works/pi-ai/oauth'
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
  getModelsByProviderType: (providerType: string) => Promise<AvailableModel[]>
  getLiveModels: (providerId: string) => Promise<AvailableModel[]>
  getImageModelsByProviderType: (providerType: string) => AvailableImageModel[]
  refreshModelCatalogs: () => Promise<ProviderCatalogRefreshResultContract[]>
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
  updateProviderModel: (providerId: string, modelId: string, payload: ProviderModelUpdatePayloadContract) => ProviderConfig
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
  testImageModel: (id: string, modelId: string) => Promise<ProviderImageTestResultContract>
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

  async function getModelsByProviderType(providerType: string): Promise<AvailableModel[]> {
    try {
      if (isRadiusProviderType(providerType)) {
        return radiusCatalogToAvailableModels(await refreshRadiusCatalogForPicker())
      }
      return getAvailableModels(providerType as ProviderType)
    } catch (err) {
      throw new ProvidersRuntimeError(`Failed to get models: ${(err as Error).message}`)
    }
  }

  /**
   * Radius has no bundled catalog, so the create-mode picker needs the gateway
   * listing. An existing Radius provider's credential is used so the result
   * includes organization-private models and never downgrades an
   * authenticated cache. A failed refresh (gateway down, rate-limited, OAuth
   * refresh error) degrades to the persisted catalog like `getLiveModels`;
   * only a cold cache propagates the error.
   */
  async function refreshRadiusCatalogForPicker() {
    const radiusProvider = loadProvidersDecrypted().providers.find(p => isRadiusProviderType(p.providerType))
    try {
      const apiKey = radiusProvider ? await resolveCatalogApiKey(radiusProvider) : undefined
      return await refreshRadiusCatalog({ apiKey })
    } catch (err) {
      const cached = getRadiusCatalog()
      if (!cached) throw err
      console.warn(`[axiom] Radius catalog refresh failed, using cached catalog: ${(err as Error).message}`)
      return cached
    }
  }

  async function getLiveModels(providerId: string): Promise<AvailableModel[]> {
    const provider = requireProvider(providerId)
    if (!isDynamicCatalogProvider(provider.providerType)) {
      throw new ProvidersValidationError('Provider type does not use a dynamic catalog')
    }

    try {
      if (isRadiusProviderType(provider.providerType)) {
        return radiusCatalogToAvailableModels(await refreshRadiusCatalog({
          apiKey: await resolveCatalogApiKey(provider),
          force: true,
        }))
      }
      const isImageOnly = createImageOnlyModelIdMatcher(provider.providerType)
      const models = await fetchModelsFromBase(provider.baseUrl, provider.apiKey || undefined, provider.type)
      return models.filter(model => !isImageOnly(model.id))
    } catch (err) {
      const fallback = getAvailableModels(provider.providerType as ProviderType)
      if (fallback.length === 0) throw err
      console.warn(`[axiom] Live model fetch failed for provider "${provider.name}", using bundled catalog: ${(err as Error).message}`)
      return fallback
    }
  }

  function getImageModelsByProviderType(providerType: string): AvailableImageModel[] {
    return getAvailableImageModels(providerType as ProviderType)
  }

  function usableImageModelSignature(): string {
    return JSON.stringify(loadProviders().providers.map(p => [p.id, getUsableImageModels(p)]))
  }

  /** Background agents build their tool set once; tell them when `generate_image` may have to appear or vanish. */
  function notifyOnImageModelChange<T>(mutate: () => T): T {
    const before = usableImageModelSignature()
    const result = mutate()
    if (usableImageModelSignature() !== before) options.onImageModelsChanged?.()
    return result
  }

  /**
   * Refresh every catalog behind the configured providers: the pi.dev overlay
   * per pi-ai provider (shared by e.g. `anthropic` and `anthropic-oauth`) and
   * the Radius gateway catalog. Providers without a catalog (custom presets,
   * Ollama, …) are skipped; their models are fetched live in the Add Model dialog.
   */
  async function refreshModelCatalogs(): Promise<ProviderCatalogRefreshResultContract[]> {
    const providers = loadProvidersDecrypted().providers
    const piProviders = providers
      .map(p => PROVIDER_TYPE_PRESETS[p.providerType as ProviderType]?.piAiProvider)
      .filter((id): id is string => Boolean(id))
    const radiusProvider = providers.find(p => isRadiusProviderType(p.providerType))

    const [piResults, radiusResult] = await Promise.all([
      refreshPiCatalogs(piProviders),
      radiusProvider ? refreshRadiusForCatalogs(radiusProvider) : Promise.resolve(null),
    ])
    const piResultByProvider = new Map(piResults.map(r => [r.piProvider, r]))

    return providers.flatMap((provider): ProviderCatalogRefreshResultContract[] => {
      const result = isRadiusProviderType(provider.providerType)
        ? radiusResult
        : piResultByProvider.get(PROVIDER_TYPE_PRESETS[provider.providerType as ProviderType]?.piAiProvider ?? '')
      if (!result) return []
      return [{
        providerId: provider.id,
        providerName: provider.name,
        status: result.status,
        addedModelIds: result.addedModelIds,
        missingModelIds: findMissingCatalogModels(provider),
        ...(result.error ? { error: result.error } : {}),
      }]
    })
  }

  async function refreshRadiusForCatalogs(provider: ProviderConfig): Promise<{
    status: 'updated' | 'unchanged' | 'error'
    addedModelIds: string[]
    error?: string
  }> {
    const before = new Set((getRadiusCatalog()?.models ?? []).map(m => m.id))
    try {
      const catalog = await refreshRadiusCatalog({ apiKey: await resolveCatalogApiKey(provider), force: true })
      const addedModelIds = catalog.models.map(m => m.id).filter(id => !before.has(id))
      return { status: addedModelIds.length > 0 ? 'updated' : 'unchanged', addedModelIds }
    } catch (err) {
      return { status: 'error', addedModelIds: [], error: (err as Error).message }
    }
  }

  /**
   * Catalog-resolved providers (subscriptions, OpenCode, Radius) take wire
   * details from the catalog, so an enabled model the catalog dropped falls
   * back to a generic build that may not work. Other providers accept custom
   * model ids by design and are not checked.
   */
  function findMissingCatalogModels(provider: ProviderConfig): string[] {
    if (supportsModelSpecOverrides(provider.providerType)) return []
    const available = new Set(getAvailableModels(provider.providerType as ProviderType).map(m => m.id))
    return (provider.enabledModels ?? []).filter(id => !available.has(id))
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

    const oauthProvider = getOAuthAuth(preset.oauthProviderId)
    if (!oauthProvider) {
      throw new ProvidersValidationError(`OAuth provider "${preset.oauthProviderId}" not found`)
    }

    // Resume an already-running login for the same target instead of starting
    // a second one. Callback-server flows (e.g. Anthropic) bind a fixed local
    // port that stays open until the flow completes; spawning a fresh login
    // while the previous one is still pending would fail with EADDRINUSE. This
    // also lets the UI recover the flow after a page refresh.
    for (const [existingId, existing] of pendingOAuthLogins) {
      const sameTarget = payload.providerId
        ? existing.existingProviderId === payload.providerId
        : existing.existingProviderId == null
          && existing.providerType === payload.providerType
          && existing.name === payload.name
      if (!sameTarget) continue
      if (existing.status === 'pending' && existing.authUrl) {
        return {
          loginId: existingId,
          authUrl: existing.authUrl,
          instructions: existing.instructions,
          usesCallbackServer: existing.resolveManualCode != null,
        }
      }
      // Stale completed/errored entry for this target — drop it and start fresh.
      pendingOAuthLogins.delete(existingId)
    }
    maybeStopOAuthCleanupTimer()

    const loginId = crypto.randomUUID()
    const loginState: PendingOAuthLogin = {
      status: 'pending',
      providerType: payload.providerType,
      name: payload.name,
      enabledModels: payload.enabledModels,
      textVerbosity: payload.textVerbosity,
      transport: payload.transport,
      createdAt: Date.now(),
      existingProviderId: payload.providerId,
    }
    pendingOAuthLogins.set(loginId, loginState)
    ensureOAuthCleanupTimer()

    let resolveAuthInfo!: (info: { url: string; instructions?: string }) => void
    const authInfoPromise = new Promise<{ url: string; instructions?: string }>((resolve) => {
      resolveAuthInfo = resolve
    })

    oauthLogin(preset.oauthProviderId, {
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
        onDeviceCode: (info) => {
          const url = deviceCodeAuthUrl(preset.oauthProviderId!, info)
          loginState.authUrl = url
          loginState.instructions = info.userCode
          resolveAuthInfo({ url, instructions: info.userCode })
        },
        // Browser flows bind a callback server on the backend host, which only
        // works when the browser runs on the same machine. Radius offers a
        // `device-code` option that works for remote deployments, so pick it.
        // Other providers (e.g. Codex, `device_code`) deliberately keep their
        // first option to leave existing login behaviour untouched.
        onSelect: async ({ options: choices }) => choices.find((o) => o.id === 'device-code')?.id,
        onManualCodeInput: () =>
          new Promise<string>((resolve) => {
            loginState.resolveManualCode = resolve
          }),
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

    // Callback-server flows request a manual-code fallback synchronously after
    // announcing the auth URL, so the resolver is set by the time this awaited
    // continuation runs. Device-code flows never prompt for one.
    return {
      loginId,
      authUrl: authInfo.url,
      instructions: authInfo.instructions,
      usesCallbackServer: loginState.resolveManualCode != null,
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
            enabledModels: loginState.enabledModels,
            textVerbosity: loginState.textVerbosity ?? undefined,
            transport: loginState.transport ?? undefined,
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
        enabledModels: payload.enabledModels,
        degradedThresholdMs: payload.degradedThresholdMs,
        textVerbosity: payload.textVerbosity ?? undefined,
        transport: payload.transport ?? undefined,
        extraFields: payload.extraFields,
        compat: payload.compat,
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

  function resetDisabledReferences(): void {
    const scheduledTaskStore = options.db ? new ScheduledTaskStore(options.db) : undefined
    const { settingsPaths, cronjobIds } = resetDisabledProviderReferences({ scheduledTaskStore })
    if (settingsPaths.length > 0 || cronjobIds.length > 0) {
      options.onProviderReferencesReset?.()
    }
  }

  function applyDisabledChange(disabled: boolean | undefined, apply: (disabled: boolean) => unknown): void {
    if (disabled === undefined) return
    const fallbackBefore = loadProviders().fallbackProvider ?? null
    apply(disabled)
    if (disabled) resetDisabledReferences()
    if ((loadProviders().fallbackProvider ?? null) !== fallbackBefore) {
      options.onFallbackProviderChanged?.()
    }
  }

  function updateProvider(id: string, payload: ProviderUpdatePayloadContract): ProviderConfig {
    return notifyOnImageModelChange(() => applyProviderUpdate(id, payload))
  }

  function applyProviderUpdate(id: string, payload: ProviderUpdatePayloadContract): ProviderConfig {
    try {
      const { disabled, ...configPayload } = payload
      applyDisabledChange(disabled, value => setProviderDisabled(id, value))

      const hasConfigChanges = Object.values(configPayload).some(value => value !== undefined)
      if (!hasConfigChanges) {
        const provider = loadProviders().providers.find(entry => entry.id === id)
        if (!provider) throw new ProvidersNotFoundError(`Provider not found: ${id}`)
        return provider
      }

      const activeProvider = loadProviders().activeProvider ?? null
      const provider = updateProviderConfig(id, {
        name: configPayload.name,
        providerType: configPayload.providerType as ProviderType | undefined,
        baseUrl: configPayload.baseUrl,
        apiKey: configPayload.apiKey,
        enabledModels: configPayload.enabledModels,
        enabledImageModels: configPayload.enabledImageModels,
        degradedThresholdMs: configPayload.degradedThresholdMs,
        textVerbosity: configPayload.textVerbosity,
        transport: configPayload.transport,
        extraFields: configPayload.extraFields,
        compat: configPayload.compat,
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
      notifyOnImageModelChange(() => deleteProviderConfig(id))
    } catch (err) {
      const message = (err as Error).message
      if (message.includes('not found')) {
        throw new ProvidersNotFoundError(message)
      }
      throw new ProvidersValidationError(message)
    }
  }

  function updateProviderModel(providerId: string, modelId: string, payload: ProviderModelUpdatePayloadContract): ProviderConfig {
    try {
      const { disabled, ...metadataPatch } = payload
      let provider: ProviderConfig | undefined
      applyDisabledChange(disabled, value => {
        provider = setProviderModelDisabled(providerId, modelId, value)
      })
      if (Object.keys(metadataPatch).length > 0) {
        provider = updateProviderModelConfig(providerId, modelId, metadataPatch)
      }
      return provider!
    } catch (err) {
      if (err instanceof ProviderNotFoundError) {
        throw new ProvidersNotFoundError(err.message)
      }
      throw new ProvidersValidationError((err as Error).message)
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
    if (payload.modelType === 'image') {
      return testImageModelAvailability(provider, modelId)
    }
    const testProviderConfig = modelId ? { ...provider, enabledModels: [modelId] } : provider
    const testModelId = modelId ?? getProviderDefaultModel(provider)

    const result = await performProviderHealthCheck(testProviderConfig, {
      // Hosted "free" endpoints (notably NVIDIA NIM partner/free models) can
      // cold-start or queue for longer than the regular health-monitor timeout.
      // Manual tests should answer "does this model work?" rather than marking
      // slow-but-valid models as broken after 15s.
      timeoutMs: 60_000,
    })
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

  function requireEnabledImageModel(provider: ProviderConfig, modelId: string | undefined): string {
    if (!modelId || !(provider.enabledImageModels ?? []).includes(modelId)) {
      throw new ProvidersValidationError(`Image model "${modelId ?? ''}" is not enabled for provider "${provider.name}"`)
    }
    return modelId
  }

  async function testImageModelAvailability(provider: ProviderConfig, requestedModelId: string | undefined) {
    const modelId = requireEnabledImageModel(provider, requestedModelId)
    const result = await checkImageModelAvailability(provider, modelId)
    updateProviderStatus(provider.id, result.status === 'down' ? 'error' : 'connected', modelId)

    if (result.status === 'down') {
      return { success: false, error: result.errorMessage ?? 'Availability check failed', modelId }
    }
    return {
      success: true,
      message: result.status === 'degraded'
        ? `Available, but slow response (${result.latencyMs}ms)`
        : `Available. Image model: ${modelId}`,
      latencyMs: result.latencyMs ?? undefined,
      status: result.status,
      modelId,
    }
  }

  async function testImageModel(id: string, requestedModelId: string): Promise<ProviderImageTestResultContract> {
    const provider = requireProvider(id)
    const modelId = requireEnabledImageModel(provider, requestedModelId)
    const result = await generateImagesWithProvider({ provider, modelId, prompt: IMAGE_TEST_PROMPT, count: 1 })

    if (options.db) {
      logTokenUsage(options.db, {
        provider: result.model.provider,
        model: result.model.id,
        promptTokens: result.usage.input,
        completionTokens: result.usage.output,
        cacheRead: result.usage.cacheRead,
        cacheWrite: result.usage.cacheWrite,
        estimatedCost: result.costUsd ?? 0,
      })
    }

    const image = result.images[0]
    updateProviderStatus(id, image ? 'connected' : 'error', modelId)
    if (!image) {
      return {
        success: false,
        modelId,
        error: result.errors.join(' ') || 'No image returned',
        costUsd: result.costUsd,
        durationMs: result.durationMs,
      }
    }
    return {
      success: true,
      modelId,
      dataUrl: `data:${image.mimeType};base64,${image.data}`,
      mimeType: image.mimeType,
      costUsd: result.costUsd,
      durationMs: result.durationMs,
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
    getLiveModels,
    getImageModelsByProviderType,
    refreshModelCatalogs,
    setFallback,
    startOAuthLogin,
    getOAuthStatus,
    submitOAuthCode,
    createProvider,
    updateProvider,
    updateProviderModel,
    deleteProvider,
    testProvider,
    testImageModel,
    activateProvider,
    probeOllamaModels,
    listOllamaModels,
    requestOllamaProbePull,
    requestOllamaPull,
    deleteOllamaModel,
  }
}

/**
 * Radius' `/pair` page accepts the user code as `?code=` (mirrors the
 * `verification_uri_complete` the device endpoint returns, which pi-ai does
 * not surface). Saves the user a copy/paste; the code is still shown in the UI.
 */
function deviceCodeAuthUrl(oauthProviderId: string, info: { verificationUri: string; userCode: string }): string {
  if (oauthProviderId !== 'radius') return info.verificationUri
  const url = new URL(info.verificationUri)
  url.searchParams.set('code', info.userCode)
  return url.toString()
}

/** Credential for the catalog fetch; OAuth refresh failures propagate to the caller. */
async function resolveCatalogApiKey(provider: ProviderConfig): Promise<string | undefined> {
  const key = await getApiKeyForProvider(provider)
  return key && key !== 'no-key' ? key : undefined
}

/** List models from a provider's own `/models` endpoint (OpenAI- or Anthropic-style). */
async function fetchModelsFromBase(baseUrl: string, apiKey: string | undefined, apiType: string): Promise<AvailableModel[]> {
  validateBaseUrl(baseUrl)

  // Anthropic-style endpoints take the key as `x-api-key` and their base URL
  // excludes `/v1` (the SDK appends `/v1/messages`).
  const isAnthropic = apiType === 'anthropic-messages'
  const authHeaders: Record<string, string> = !apiKey
    ? {}
    : isAnthropic
      ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
      : { Authorization: `Bearer ${apiKey}` }
  const urls = isAnthropic ? buildAnthropicModelsProbeUrls(baseUrl) : buildOpenAiModelsProbeUrls(baseUrl)
  let lastError = 'No /models endpoint responded successfully'

  for (const url of urls) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: 'application/json',
          ...authHeaders,
        },
        signal: AbortSignal.timeout(15_000),
      })

      if (!response.ok) {
        lastError = `HTTP ${response.status}`
        continue
      }

      const body = await response.json() as { data?: ProbedModelEntry[] }
      const seen = new Set<string>()
      const models: AvailableModel[] = []
      for (const entry of body.data ?? []) {
        const id = typeof entry.id === 'string' ? entry.id.trim() : ''
        if (!id || seen.has(id) || !isChatCapableMode(entry.mode)) continue
        seen.add(id)
        const displayName = [entry.name, entry.display_name].find(v => typeof v === 'string' && v.trim()) as string | undefined
        const name = displayName?.trim() ?? id
        const cost = parseProbedModelCost(entry.pricing)
        const contextWindow = firstPositiveInteger(entry.context_length, entry.max_input_tokens)
        const maxTokens = firstPositiveInteger(entry.max_output_tokens)
        models.push({
          id,
          name,
          ...(contextWindow ? { contextWindow } : {}),
          ...(maxTokens ? { maxTokens } : {}),
          ...(cost ? { cost } : {}),
        })
      }
      return models.sort((a, b) => a.id.localeCompare(b.id))
    } catch (err) {
      lastError = (err as Error).message
    }
  }

  throw new ProvidersExternalError(lastError)
}

/** OpenRouter uses `context_length`; LiteLLM-style proxies use `max_input_tokens` / `max_output_tokens` / `mode`. */
interface ProbedModelEntry {
  id?: unknown
  name?: unknown
  /** Anthropic `/v1/models`. */
  display_name?: unknown
  mode?: unknown
  context_length?: unknown
  max_input_tokens?: unknown
  max_output_tokens?: unknown
  pricing?: { prompt?: unknown; completion?: unknown; input_cache_read?: unknown; input_cache_write?: unknown }
}

const CHAT_CAPABLE_MODES = new Set(['chat', 'completion', 'responses'])

function isChatCapableMode(mode: unknown): boolean {
  return typeof mode !== 'string' || CHAT_CAPABLE_MODES.has(mode)
}

function firstPositiveInteger(...values: unknown[]): number | undefined {
  return values.find((value): value is number => Number.isInteger(value) && (value as number) > 0)
}

/** OpenRouter reports pricing in USD per token; convert to USD per 1M tokens. */
function parseProbedModelCost(pricing: ProbedModelEntry['pricing']): AvailableModel['cost'] {
  const perMillion = (value: unknown): number | undefined => {
    if (value === undefined || value === null || value === '') return undefined
    const num = Number(value) * 1_000_000
    return Number.isFinite(num) && num >= 0 ? Math.round(num * 1e6) / 1e6 : undefined
  }
  const input = perMillion(pricing?.prompt)
  const output = perMillion(pricing?.completion)
  if (input === undefined || output === undefined) return undefined
  const cacheRead = perMillion(pricing?.input_cache_read)
  const cacheWrite = perMillion(pricing?.input_cache_write)
  return {
    input,
    output,
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
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

function validateBaseUrl(urlStr: string): void {
  let parsed: URL
  try {
    parsed = new URL(urlStr)
  } catch {
    throw new ProvidersValidationError('Invalid base URL')
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ProvidersValidationError('Only http/https URLs are allowed')
  }
}

function buildAnthropicModelsProbeUrls(baseUrl: string): string[] {
  const normalized = baseUrl.replace(/\/+$/, '')
  return /\/v1$/i.test(normalized)
    ? [`${normalized}/models`]
    : [`${normalized}/v1/models`, `${normalized}/models`]
}

function buildOpenAiModelsProbeUrls(baseUrl: string): string[] {
  const normalized = baseUrl.replace(/\/+$/, '')
  const candidates = [`${normalized}/models`]
  if (!/\/v1$/i.test(normalized)) {
    candidates.push(`${normalized}/v1/models`)
  }
  return [...new Set(candidates)]
}

function requireProvider(providerId: string): ProviderConfig {
  const data = loadProvidersDecrypted()
  const provider = data.providers.find((entry) => entry.id === providerId)
  if (!provider) {
    throw new ProvidersNotFoundError('Provider not found')
  }

  return provider
}
