import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { __setPiCatalogForTests, __setRadiusCatalogForTests, addOAuthProvider, addProvider, getAvailableModels, initDatabase, loadProviders, updateProvider } from '@axiom/core'
import { mapProvidersListResponse } from './mapper.js'
import {
  createProvidersService,
  ProvidersNotFoundError,
  ProvidersValidationError,
} from './service.js'

let tempDataDir: string
let previousDataDir: string | undefined

beforeAll(() => {
  previousDataDir = process.env.DATA_DIR
})

afterAll(() => {
  if (previousDataDir === undefined) {
    delete process.env.DATA_DIR
  } else {
    process.env.DATA_DIR = previousDataDir
  }
})

beforeEach(() => {
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-providers-service-'))
  process.env.DATA_DIR = tempDataDir
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(tempDataDir, { recursive: true, force: true })
})

describe('getLiveModels (dynamic catalog)', () => {
  function createOpenRouterProvider() {
    return addProvider({
      name: 'OpenRouter',
      providerType: 'openrouter',
      apiKey: 'sk-openrouter-test',
      enabledModels: [],
    })
  }

  it('returns the live /models list, sorted and deduped, replacing the curated catalog', async () => {
    const provider = createOpenRouterProvider()

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ data: [{ id: 'z/model-two' }, { id: 'a/model-one' }, { id: 'a/model-one' }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )

    const service = createProvidersService()
    const models = await service.getLiveModels(provider.id)

    expect(models).toEqual([
      { id: 'a/model-one', name: 'a/model-one' },
      { id: 'z/model-two', name: 'z/model-two' },
    ])
  })

  it('maps display name, context window and per-1M-token cost from the live response', async () => {
    const provider = createOpenRouterProvider()

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              id: 'a/model-one',
              name: 'Model One',
              context_length: 1048576,
              pricing: {
                prompt: '0.0000001',
                completion: '0.0000004',
                input_cache_read: '0.00000001',
                input_cache_write: '0.000000125',
              },
            },
            { id: 'b/no-metadata', pricing: { prompt: '-1', completion: '-1' } },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )

    const service = createProvidersService()
    const models = await service.getLiveModels(provider.id)

    expect(models).toEqual([
      {
        id: 'a/model-one',
        name: 'Model One',
        contextWindow: 1048576,
        cost: { input: 0.1, output: 0.4, cacheRead: 0.01, cacheWrite: 0.125 },
      },
      { id: 'b/no-metadata', name: 'b/no-metadata' },
    ])
  })

  it('falls back to the curated catalog when the live fetch fails', async () => {
    const provider = createOpenRouterProvider()

    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'))

    const service = createProvidersService()
    const models = await service.getLiveModels(provider.id)

    expect(models).toEqual(getAvailableModels('openrouter'))
    expect(models.length).toBeGreaterThan(0)
  })

  it('serves a custom provider catalog live from its base URL', async () => {
    const provider = addProvider({
      name: 'Custom',
      providerType: 'custom-openai-completions',
      baseUrl: 'https://llm.example.com/v1',
      apiKey: 'sk-custom',
      enabledModels: [],
    })

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'local/model' }] }), { status: 200 }),
    )

    const service = createProvidersService()
    const models = await service.getLiveModels(provider.id)

    expect(models).toEqual([{ id: 'local/model', name: 'local/model' }])
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('https://llm.example.com/v1/models')
  })

  it('maps LiteLLM-style token limits and skips non-chat models', async () => {
    const provider = addProvider({
      name: 'LiteLLM',
      providerType: 'custom-openai-completions',
      baseUrl: 'https://llm.example.com/v1',
      enabledModels: [],
    })

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        data: [
          { id: 'DeepSeek-V4-Flash', mode: 'chat', max_input_tokens: 1_000_000, max_output_tokens: 393_216 },
          { id: 'text-embedding-3', mode: 'embedding', max_input_tokens: 8191 },
        ],
      }), { status: 200 }),
    )

    const models = await createProvidersService().getLiveModels(provider.id)

    expect(models).toEqual([
      { id: 'DeepSeek-V4-Flash', name: 'DeepSeek-V4-Flash', contextWindow: 1_000_000, maxTokens: 393_216 },
    ])
  })

  it('lists anthropic-style custom providers via /v1/models with x-api-key', async () => {
    const provider = addProvider({
      name: 'Anthropic proxy',
      providerType: 'custom-anthropic-messages',
      baseUrl: 'https://proxy.example.com/anthropic',
      apiKey: 'sk-proxy',
      enabledModels: [],
    })

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'claude-x', display_name: 'Claude X', type: 'model' }] }), { status: 200 }),
    )

    const models = await createProvidersService().getLiveModels(provider.id)

    expect(models).toEqual([{ id: 'claude-x', name: 'Claude X' }])
    const [url, init] = fetchSpy.mock.calls[0]!
    expect(url).toBe('https://proxy.example.com/anthropic/v1/models')
    expect((init as RequestInit).headers).toMatchObject({ 'x-api-key': 'sk-proxy', 'anthropic-version': '2023-06-01' })
  })

  it('propagates the live fetch error when there is no catalog to fall back to', async () => {
    const provider = addProvider({
      name: 'Custom',
      providerType: 'custom-openai-completions',
      baseUrl: 'https://llm.example.com/v1',
      enabledModels: [],
    })

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 401 }))

    const service = createProvidersService()
    await expect(service.getLiveModels(provider.id)).rejects.toThrow('HTTP 401')
  })

  it('rejects provider types that do not use a dynamic catalog', async () => {
    const provider = addProvider({
      name: 'OpenAI',
      providerType: 'openai',
      apiKey: 'sk-openai-test',
      enabledModels: [],
    })

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const service = createProvidersService()

    await expect(service.getLiveModels(provider.id)).rejects.toBeInstanceOf(ProvidersValidationError)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('rejects an unknown provider id', async () => {
    const service = createProvidersService()
    await expect(service.getLiveModels('does-not-exist')).rejects.toBeInstanceOf(ProvidersNotFoundError)
  })
})

describe('getModelsByProviderType (Radius)', () => {
  const kimi = {
    id: 'kimi-k3',
    name: 'Kimi K3',
    reasoning: true,
    input: ['text'] as ('text' | 'image')[],
    contextWindow: 1_000_000,
    maxTokens: 100_000,
    cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
  }
  const staleAuthenticatedCatalog = {
    checkedAt: Date.now() - 7 * 60 * 60 * 1000,
    baseUrl: 'https://radius.pi.dev/v1',
    models: [kimi, { ...kimi, id: 'org/private-model', name: 'Private' }],
    authenticated: true,
  }

  afterEach(() => {
    __setRadiusCatalogForTests(undefined)
  })

  it('uses the configured Radius provider credential for the refresh', async () => {
    addProvider({ name: 'Radius', providerType: 'radius-api-key', apiKey: 'org-key', enabledModels: [] })
    __setRadiusCatalogForTests(staleAuthenticatedCatalog)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ baseUrl: 'https://radius.pi.dev/v1', models: [kimi] }), { status: 200 }),
    )

    const models = await createProvidersService().getModelsByProviderType('radius')

    expect(models.map(m => m.id)).toEqual(['kimi-k3'])
    const headers = (fetchSpy.mock.calls[0]![1] as RequestInit).headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer org-key')
  })

  it('falls back to the cached catalog when the refresh fails', async () => {
    __setRadiusCatalogForTests(staleAuthenticatedCatalog)
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const models = await createProvidersService().getModelsByProviderType('radius')

    expect(models.map(m => m.id)).toEqual(['kimi-k3', 'org/private-model'])
  })

  it('fails when the refresh fails and no catalog is cached', async () => {
    __setRadiusCatalogForTests(null)
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'))

    await expect(createProvidersService().getModelsByProviderType('radius')).rejects.toThrow(/network down/)
  })
})

describe('refreshModelCatalogs', () => {
  afterEach(() => __setPiCatalogForTests(undefined))

  it('refreshes each pi catalog once and reports new and missing models per provider', async () => {
    __setPiCatalogForTests(undefined)
    addProvider({ name: 'Anthropic API', providerType: 'anthropic', apiKey: 'sk-ant', enabledModels: ['custom-model'] })
    addOAuthProvider({
      name: 'Claude Max',
      providerType: 'anthropic-oauth',
      enabledModels: ['claude-sonnet-4-5', 'claude-retired-1'],
      oauthCredentials: { access: 'a', refresh: 'r', expires: Date.now() + 60_000 },
    })
    addProvider({ name: 'Local', providerType: 'custom-openai-completions', baseUrl: 'http://localhost:1234/v1', enabledModels: ['x'] })

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify([
      {
        id: 'claude-future-9', name: 'Claude Future 9', api: 'anthropic-messages', provider: 'anthropic',
        baseUrl: 'https://api.anthropic.com', reasoning: true, input: ['text'], contextWindow: 1, maxTokens: 1,
        cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      },
    ]), { status: 200 }))

    const results = await createProvidersService().refreshModelCatalogs()

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(results.map(r => r.providerName)).toEqual(['Anthropic API', 'Claude Max'])
    expect(results[0]).toMatchObject({ status: 'updated', addedModelIds: ['claude-future-9'], missingModelIds: [] })
    expect(results[1]).toMatchObject({ status: 'updated', missingModelIds: ['claude-retired-1'] })
  })
})

describe('image generation models', () => {
  const PNG_BASE64 = Buffer.from('png-bytes').toString('base64')

  function createOpenRouterProvider(enabledImageModels: string[] = []) {
    const provider = addProvider({
      name: 'OpenRouter',
      providerType: 'openrouter',
      apiKey: 'test-key',
      enabledModels: ['qwen/qwen3.8-flash'],
    })
    if (enabledImageModels.length === 0) return provider
    return updateProvider(provider.id, { enabledImageModels })
  }

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  }

  it('lists the image catalog per provider type', () => {
    const service = createProvidersService()
    expect(service.getImageModelsByProviderType('openrouter').map(m => m.id)).toContain('recraft/recraft-v4.1-vector')
    expect(service.getImageModelsByProviderType('anthropic')).toEqual([])
  })

  it('hides image-only models from the live text model list', async () => {
    const provider = createOpenRouterProvider()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      data: [{ id: 'openai/gpt-5-image-mini' }, { id: 'google/gemini-3-pro-image' }, { id: 'qwen/qwen3.8-flash' }],
    }))

    const models = await createProvidersService().getLiveModels(provider.id)

    expect(models.map(m => m.id)).toEqual(['google/gemini-3-pro-image', 'qwen/qwen3.8-flash'])
  })

  it('notifies when the usable image models change, and only then', () => {
    addProvider({ name: 'Active', providerType: 'anthropic', apiKey: 'test-key', enabledModels: ['claude-sonnet-4-5'] })
    const provider = createOpenRouterProvider()
    const onImageModelsChanged = vi.fn()
    const service = createProvidersService({ onImageModelsChanged })

    service.updateProvider(provider.id, { name: 'OpenRouter 2' })
    expect(onImageModelsChanged).not.toHaveBeenCalled()

    service.updateProvider(provider.id, { enabledImageModels: ['recraft/recraft-v4.1'] })
    expect(onImageModelsChanged).toHaveBeenCalledTimes(1)
    expect(loadProviders().providers.find(p => p.id === provider.id)!.enabledImageModels).toEqual(['recraft/recraft-v4.1'])

    service.updateProvider(provider.id, { disabled: true })
    expect(onImageModelsChanged).toHaveBeenCalledTimes(2)
  })

  it('runs the free availability check instead of a chat request for image models', async () => {
    const provider = createOpenRouterProvider(['recraft/recraft-v4.1-vector'])
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => String(url).endsWith('/key')
      ? jsonResponse({ data: {} })
      : jsonResponse({ data: { architecture: { output_modalities: ['image'] }, endpoints: [{ name: 'Recraft' }] } }))

    const result = await createProvidersService().testProvider(provider.id, { modelId: 'recraft/recraft-v4.1-vector', modelType: 'image' })

    expect(result).toMatchObject({ success: true, modelId: 'recraft/recraft-v4.1-vector' })
    expect(fetchSpy.mock.calls.map(([url]) => String(url))).toEqual(expect.arrayContaining([
      'https://openrouter.ai/api/v1/models/recraft/recraft-v4.1-vector/endpoints',
      'https://openrouter.ai/api/v1/key',
    ]))
    expect(fetchSpy.mock.calls.some(([url]) => String(url).includes('/chat/completions'))).toBe(false)
    expect(loadProviders().providers[0]!.modelStatuses?.['recraft/recraft-v4.1-vector']).toBe('connected')
  })

  it('rejects image checks for models that are not enabled as image models', async () => {
    const provider = createOpenRouterProvider()
    await expect(createProvidersService().testProvider(provider.id, { modelId: 'qwen/qwen3.8-flash', modelType: 'image' }))
      .rejects.toBeInstanceOf(ProvidersValidationError)
    await expect(createProvidersService().testImageModel(provider.id, 'recraft/recraft-v4.1'))
      .rejects.toBeInstanceOf(ProvidersValidationError)
  })

  it('generates a paid test image, returns a preview with the billed cost and books it', async () => {
    const provider = createOpenRouterProvider(['recraft/recraft-v4.1'])
    const db = initDatabase(path.join(tempDataDir, 'test.db'))
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      id: 'gen-1',
      choices: [{ index: 0, message: { role: 'assistant', content: null, images: [{ type: 'image_url', image_url: { url: `data:image/webp;base64,${PNG_BASE64}` } }] } }],
      usage: { prompt_tokens: 10, completion_tokens: 100, total_tokens: 110, cost: 0.035 },
    }))

    const result = await createProvidersService({ db }).testImageModel(provider.id, 'recraft/recraft-v4.1')

    expect(result).toMatchObject({
      success: true,
      modelId: 'recraft/recraft-v4.1',
      mimeType: 'image/webp',
      dataUrl: `data:image/webp;base64,${PNG_BASE64}`,
      costUsd: 0.035,
    })
    expect(db.prepare('SELECT model, estimated_cost FROM token_usage').get()).toEqual({ model: 'recraft/recraft-v4.1', estimated_cost: 0.035 })
    db.close()
  })

  it('exposes image model specs and the preset capability in the list response', () => {
    createOpenRouterProvider(['recraft/recraft-v4.1-vector'])
    const { masked, decrypted } = createProvidersService().listProviders()
    const response = mapProvidersListResponse(masked, decrypted)

    expect(response.providers[0]!.enabledImageModels).toEqual(['recraft/recraft-v4.1-vector'])
    expect(response.providers[0]!.imageModelSpecs?.['recraft/recraft-v4.1-vector']).toMatchObject({ name: 'Recraft: Recraft V4.1 Vector', output: ['image'] })
    expect(response.providers[0]!.modelSpecs).not.toHaveProperty('recraft/recraft-v4.1-vector')
    expect(response.presets.openrouter!.supportsImageModels).toBe(true)
    expect(response.presets.anthropic!.supportsImageModels).toBe(false)
  })
})
