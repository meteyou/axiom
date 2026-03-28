import crypto from 'node:crypto'
import { Router } from 'express'
import {
  loadProviders,
  loadProvidersMasked,
  loadProvidersDecrypted,
  addProvider,
  addOAuthProvider,
  updateProvider,
  deleteProvider,
  setActiveProvider,
  updateProviderStatus,
  getAvailableModels,
  buildModel,
  PROVIDER_TYPE_PRESETS,
  performProviderHealthCheck,
} from '@openagent/core'
import { getModels as getPiAiModels } from '@mariozechner/pi-ai'
import type { KnownProvider as PiAiKnownProvider } from '@mariozechner/pi-ai'
import type { ProviderType } from '@openagent/core'
import { getOAuthProvider } from '@mariozechner/pi-ai/oauth'
import type { OAuthCredentials } from '@mariozechner/pi-ai/oauth'
import { jwtMiddleware } from '../auth.js'
import type { AuthenticatedRequest } from '../auth.js'

const VALID_PROVIDER_TYPES = Object.keys(PROVIDER_TYPE_PRESETS)

export interface ProvidersRouterOptions {
  onActiveProviderChanged?: () => void
}

/**
 * In-memory state for pending OAuth login flows
 */
interface PendingOAuthLogin {
  status: 'pending' | 'completed' | 'error'
  providerType: string
  name: string
  defaultModel: string
  authUrl?: string
  instructions?: string
  credentials?: OAuthCredentials
  error?: string
  resolveManualCode?: (code: string) => void
  createdAt: number
}

const pendingOAuthLogins = new Map<string, PendingOAuthLogin>()

// Clean up stale logins older than 10 minutes
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000
  for (const [id, login] of pendingOAuthLogins) {
    if (login.createdAt < cutoff) {
      pendingOAuthLogins.delete(id)
    }
  }
}, 60 * 1000)

export function createProvidersRouter(options: ProvidersRouterOptions = {}): Router {
  const router = Router()

  // All provider routes require admin JWT
  router.use(jwtMiddleware)
  router.use((req: AuthenticatedRequest, res, next) => {
    if (req.user?.role !== 'admin') {
      res.status(403).json({ error: 'Admin access required' })
      return
    }
    next()
  })

  /**
   * GET /api/providers
   * List all providers with masked API keys
   */
  router.get('/', (_req: AuthenticatedRequest, res) => {
    try {
      const data = loadProvidersMasked()
      const decrypted = loadProvidersDecrypted()
      const providersWithCost = data.providers.map(p => {
        const full = decrypted.providers.find(d => d.id === p.id)
        let cost: { input: number; output: number } | null = null
        if (full) {
          try {
            const model = buildModel(full)
            if (model.cost.input > 0 || model.cost.output > 0) {
              cost = { input: model.cost.input, output: model.cost.output }
            }
          } catch { /* ignore */ }

          // Fallback: look up cost directly from pi-ai model registry
          if (!cost) {
            const preset = PROVIDER_TYPE_PRESETS[full.providerType as ProviderType]
            if (preset?.piAiProvider) {
              try {
                const piModels = getPiAiModels(preset.piAiProvider as PiAiKnownProvider)
                const match = piModels.find(m => m.id === full.defaultModel)
                if (match && (match.cost.input > 0 || match.cost.output > 0)) {
                  cost = { input: match.cost.input, output: match.cost.output }
                }
              } catch { /* ignore */ }
            }
          }
        }
        return { ...p, cost }
      })
      res.json({
        providers: providersWithCost,
        activeProvider: data.activeProvider ?? null,
        presets: PROVIDER_TYPE_PRESETS,
      })
    } catch (err) {
      res.status(500).json({ error: `Failed to load providers: ${(err as Error).message}` })
    }
  })

  /**
   * GET /api/providers/models/:providerType
   * Get available models for a provider type from pi-ai
   */
  router.get('/models/:providerType', (_req: AuthenticatedRequest, res) => {
    const providerType = _req.params.providerType as string

    if (!VALID_PROVIDER_TYPES.includes(providerType)) {
      res.status(400).json({ error: `Invalid provider type. Must be one of: ${VALID_PROVIDER_TYPES.join(', ')}` })
      return
    }

    try {
      const models = getAvailableModels(providerType as ProviderType)
      res.json({ models })
    } catch (err) {
      res.status(500).json({ error: `Failed to get models: ${(err as Error).message}` })
    }
  })

  /**
   * POST /api/providers/oauth/login
   * Start an OAuth login flow for a subscription provider
   */
  router.post('/oauth/login', async (req: AuthenticatedRequest, res) => {
    const { providerType, name, defaultModel } = req.body as {
      providerType?: string
      name?: string
      defaultModel?: string
    }

    if (!providerType || !VALID_PROVIDER_TYPES.includes(providerType)) {
      res.status(400).json({ error: 'Invalid provider type' })
      return
    }
    if (!name?.trim()) {
      res.status(400).json({ error: 'Provider name is required' })
      return
    }
    if (!defaultModel?.trim()) {
      res.status(400).json({ error: 'Default model is required' })
      return
    }

    const preset = PROVIDER_TYPE_PRESETS[providerType as ProviderType]
    if (preset.authMethod !== 'oauth' || !preset.oauthProviderId) {
      res.status(400).json({ error: 'This provider type does not use OAuth' })
      return
    }

    const oauthProvider = getOAuthProvider(preset.oauthProviderId)
    if (!oauthProvider) {
      res.status(400).json({ error: `OAuth provider "${preset.oauthProviderId}" not found` })
      return
    }

    const loginId = crypto.randomUUID()
    const loginState: PendingOAuthLogin = {
      status: 'pending',
      providerType,
      name: name.trim(),
      defaultModel: defaultModel.trim(),
      createdAt: Date.now(),
    }
    pendingOAuthLogins.set(loginId, loginState)

    // Promise that resolves when onAuth is called
    let resolveAuthInfo: (info: { url: string; instructions?: string }) => void
    const authInfoPromise = new Promise<{ url: string; instructions?: string }>((resolve) => {
      resolveAuthInfo = resolve
    })

    // Start login flow in background
    oauthProvider.login({
      onAuth: (info) => {
        loginState.authUrl = info.url
        loginState.instructions = info.instructions
        resolveAuthInfo!(info)
      },
      onPrompt: async (prompt) => {
        // Use defaults for prompts (e.g., GitHub Enterprise domain → github.com)
        if (prompt.allowEmpty) return ''
        return prompt.placeholder ?? ''
      },
      onProgress: () => {},
      onManualCodeInput: oauthProvider.usesCallbackServer
        ? () => new Promise<string>((resolve) => {
            loginState.resolveManualCode = resolve
          })
        : undefined,
    }).then(credentials => {
      loginState.status = 'completed'
      loginState.credentials = credentials
    }).catch(err => {
      loginState.status = 'error'
      loginState.error = (err as Error).message
      // Resolve authInfo if it hasn't been resolved yet (error before onAuth)
      resolveAuthInfo!({ url: '', instructions: '' })
    })

    // Wait for auth URL (or error)
    const authInfo = await authInfoPromise

    if (loginState.status === 'error') {
      pendingOAuthLogins.delete(loginId)
      res.status(500).json({ error: loginState.error ?? 'OAuth login failed' })
      return
    }

    res.json({
      loginId,
      authUrl: authInfo.url,
      instructions: authInfo.instructions,
      usesCallbackServer: oauthProvider.usesCallbackServer ?? false,
    })
  })

  /**
   * GET /api/providers/oauth/status/:loginId
   * Poll for OAuth login completion
   */
  router.get('/oauth/status/:loginId', (req: AuthenticatedRequest, res) => {
    const loginId = req.params.loginId as string
    const loginState = pendingOAuthLogins.get(loginId)
    if (!loginState) {
      res.status(404).json({ error: 'Login session not found or expired' })
      return
    }

    if (loginState.status === 'completed' && loginState.credentials) {
      try {
        const beforeActiveProvider = loadProviders().activeProvider ?? null
        const provider = addOAuthProvider({
          name: loginState.name,
          providerType: loginState.providerType as ProviderType,
          defaultModel: loginState.defaultModel,
          oauthCredentials: loginState.credentials,
        })
        const afterActiveProvider = loadProviders().activeProvider ?? null

        if (beforeActiveProvider !== afterActiveProvider) {
          options.onActiveProviderChanged?.()
        }

        pendingOAuthLogins.delete(loginId)
        res.json({
          status: 'completed',
          provider: { ...provider, apiKey: '', apiKeyMasked: '' },
        })
      } catch (err) {
        res.status(400).json({ status: 'error', error: (err as Error).message })
      }
      return
    }

    if (loginState.status === 'error') {
      pendingOAuthLogins.delete(loginId)
      res.json({ status: 'error', error: loginState.error })
      return
    }

    res.json({ status: 'pending' })
  })

  /**
   * POST /api/providers/oauth/code/:loginId
   * Submit manual OAuth code (fallback for remote servers)
   */
  router.post('/oauth/code/:loginId', (req: AuthenticatedRequest, res) => {
    const codeLoginId = req.params.loginId as string
    const loginState = pendingOAuthLogins.get(codeLoginId)
    if (!loginState) {
      res.status(404).json({ error: 'Login session not found or expired' })
      return
    }

    const { code } = req.body as { code?: string }
    if (!code?.trim()) {
      res.status(400).json({ error: 'Code is required' })
      return
    }

    if (loginState.resolveManualCode) {
      loginState.resolveManualCode(code.trim())
      res.json({ status: 'pending', message: 'Code submitted, processing...' })
    } else {
      res.status(400).json({ error: 'This login flow does not accept manual code input' })
    }
  })

  /**
   * POST /api/providers
   * Add a new provider
   */
  router.post('/', (req: AuthenticatedRequest, res) => {
    const { name, providerType, baseUrl, apiKey, defaultModel, degradedThresholdMs } = req.body as {
      name?: string
      providerType?: string
      baseUrl?: string
      apiKey?: string
      defaultModel?: string
      degradedThresholdMs?: number
    }

    if (!name?.trim()) {
      res.status(400).json({ error: 'Provider name is required' })
      return
    }
    if (!providerType || !VALID_PROVIDER_TYPES.includes(providerType)) {
      res.status(400).json({ error: `Invalid provider type. Must be one of: ${VALID_PROVIDER_TYPES.join(', ')}` })
      return
    }
    if (!defaultModel?.trim()) {
      res.status(400).json({ error: 'Default model is required' })
      return
    }

    const preset = PROVIDER_TYPE_PRESETS[providerType as ProviderType]
    if (preset.requiresApiKey && !apiKey?.trim()) {
      res.status(400).json({ error: 'API key is required for this provider type' })
      return
    }

    try {
      const beforeActiveProvider = loadProviders().activeProvider ?? null
      const provider = addProvider({
        name: name.trim(),
        providerType: providerType as ProviderType,
        baseUrl: baseUrl?.trim(),
        apiKey: apiKey?.trim(),
        defaultModel: defaultModel.trim(),
        degradedThresholdMs: degradedThresholdMs != null ? Math.max(1, Math.round(degradedThresholdMs)) : undefined,
      })
      const afterActiveProvider = loadProviders().activeProvider ?? null

      if (beforeActiveProvider !== afterActiveProvider) {
        options.onActiveProviderChanged?.()
      }

      res.status(201).json({
        provider: {
          ...provider,
          apiKey: '',
          apiKeyMasked: apiKey ? `${apiKey.slice(0, 4)}••••••••${apiKey.slice(-4)}` : '',
        },
      })
    } catch (err) {
      res.status(400).json({ error: (err as Error).message })
    }
  })

  /**
   * PUT /api/providers/:id
   * Update a provider
   */
  router.put('/:id', (req: AuthenticatedRequest, res) => {
    const id = req.params.id as string
    const { name, providerType, baseUrl, apiKey, defaultModel, degradedThresholdMs } = req.body as {
      name?: string
      providerType?: string
      baseUrl?: string
      apiKey?: string
      defaultModel?: string
      degradedThresholdMs?: number
    }

    if (providerType && !VALID_PROVIDER_TYPES.includes(providerType)) {
      res.status(400).json({ error: `Invalid provider type. Must be one of: ${VALID_PROVIDER_TYPES.join(', ')}` })
      return
    }

    try {
      const activeProvider = loadProviders().activeProvider ?? null
      const provider = updateProvider(id, {
        name: name?.trim(),
        providerType: providerType as ProviderType | undefined,
        baseUrl: baseUrl?.trim(),
        apiKey: apiKey?.trim(),
        defaultModel: defaultModel?.trim(),
        degradedThresholdMs: degradedThresholdMs != null ? Math.max(1, Math.round(degradedThresholdMs)) : undefined,
      })

      if (activeProvider === id) {
        options.onActiveProviderChanged?.()
      }

      res.json({
        provider: {
          ...provider,
          apiKey: '',
          apiKeyMasked: apiKey ? `${apiKey.slice(0, 4)}••••••••${apiKey.slice(-4)}` : '(unchanged)',
        },
      })
    } catch (err) {
      const message = (err as Error).message
      if (message.includes('not found')) {
        res.status(404).json({ error: message })
      } else {
        res.status(400).json({ error: message })
      }
    }
  })

  /**
   * DELETE /api/providers/:id
   * Remove a provider
   */
  router.delete('/:id', (req: AuthenticatedRequest, res) => {
    const id = req.params.id as string

    try {
      deleteProvider(id)
      res.json({ message: 'Provider deleted' })
    } catch (err) {
      const message = (err as Error).message
      if (message.includes('not found')) {
        res.status(404).json({ error: message })
      } else {
        res.status(400).json({ error: message })
      }
    }
  })

  /**
   * POST /api/providers/:id/test
   * Test provider connectivity
   */
  router.post('/:id/test', async (req: AuthenticatedRequest, res) => {
    const id = req.params.id as string

    try {
      const data = loadProvidersDecrypted()
      const provider = data.providers.find(p => p.id === id)
      if (!provider) {
        res.status(404).json({ error: 'Provider not found' })
        return
      }

      const result = await performProviderHealthCheck(provider)
      updateProviderStatus(id, result.status === 'down' ? 'error' : 'connected')

      if (result.status === 'down') {
        res.status(200).json({ success: false, error: result.errorMessage ?? 'Connection failed' })
        return
      }

      res.json({
        success: true,
        message: result.status === 'degraded'
          ? `Connected, but slow response (${result.latencyMs}ms)`
          : `Connected successfully. Model: ${provider.defaultModel}`,
        latencyMs: result.latencyMs,
        status: result.status,
      })
    } catch (err) {
      res.status(500).json({ success: false, error: `Test failed: ${(err as Error).message}` })
    }
  })

  /**
   * POST /api/providers/:id/activate
   * Set a provider as the active provider
   */
  router.post('/:id/activate', (req: AuthenticatedRequest, res) => {
    const id = req.params.id as string

    try {
      const beforeActiveProvider = loadProviders().activeProvider ?? null
      setActiveProvider(id)
      const afterActiveProvider = loadProviders().activeProvider ?? null

      if (beforeActiveProvider !== afterActiveProvider) {
        options.onActiveProviderChanged?.()
      }

      res.json({ message: 'Provider activated', activeProvider: id })
    } catch (err) {
      const message = (err as Error).message
      if (message.includes('not found')) {
        res.status(404).json({ error: message })
      } else {
        res.status(400).json({ error: message })
      }
    }
  })

  return router
}
