import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { __setRadiusCatalogForTests, addProvider, getAvailableModels } from '@axiom/core'
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
              pricing: { prompt: '0.0000001', completion: '0.0000004' },
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
        cost: { input: 0.1, output: 0.4 },
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
