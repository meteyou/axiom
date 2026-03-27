import { Router } from 'express'
import {
  loadProviders,
  loadProvidersMasked,
  loadProvidersDecrypted,
  addProvider,
  updateProvider,
  deleteProvider,
  setActiveProvider,
  updateProviderStatus,
  PROVIDER_TYPE_PRESETS,
  performProviderHealthCheck,
} from '@openagent/core'
import type { ProviderType } from '@openagent/core'
import { jwtMiddleware } from '../auth.js'
import type { AuthenticatedRequest } from '../auth.js'

const VALID_PROVIDER_TYPES = Object.keys(PROVIDER_TYPE_PRESETS)

export interface ProvidersRouterOptions {
  onActiveProviderChanged?: () => void
}

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
      res.json({
        providers: data.providers,
        activeProvider: data.activeProvider ?? null,
        presets: PROVIDER_TYPE_PRESETS,
      })
    } catch (err) {
      res.status(500).json({ error: `Failed to load providers: ${(err as Error).message}` })
    }
  })

  /**
   * POST /api/providers
   * Add a new provider
   */
  router.post('/', (req: AuthenticatedRequest, res) => {
    const { name, providerType, baseUrl, apiKey, defaultModel } = req.body as {
      name?: string
      providerType?: string
      baseUrl?: string
      apiKey?: string
      defaultModel?: string
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
    const { name, providerType, baseUrl, apiKey, defaultModel } = req.body as {
      name?: string
      providerType?: string
      baseUrl?: string
      apiKey?: string
      defaultModel?: string
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
