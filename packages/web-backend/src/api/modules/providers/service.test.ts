import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { __setPiCatalogForTests, __setRadiusCatalogForTests, addOAuthProvider, addProvider, getAvailableModels } from '@axiom/core'
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
