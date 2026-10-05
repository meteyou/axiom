import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildImageModel,
  createImageOnlyModelIdMatcher,
  getAvailableImageModels,
  getImageApiForType,
  getUsableImageModels,
  getUsableModels,
  loadProviders,
  supportsImageModels,
  updateProvider,
  updateProviderModel,
  updateProviderStatus,
} from './provider-config.js'
import type { ProviderConfig, ProvidersFile } from './provider-config.js'

const OPENROUTER_ID = 'or-1'

function openRouterProvider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: OPENROUTER_ID,
    name: 'OpenRouter',
    type: 'openai-completions',
    providerType: 'openrouter',
    provider: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: 'test-key',
    authMethod: 'api-key',
    ...overrides,
  }
}

describe('image model catalog', () => {
  it('lists image models from the pi-ai image catalog, not the text catalog', () => {
    const ids = getAvailableImageModels('openrouter').map(m => m.id)
    expect(ids).toContain('recraft/recraft-v4.1-vector')
    expect(ids).toContain('google/gemini-3.1-flash-image')
    expect(ids).not.toContain('anthropic/claude-sonnet-4.5')
  })

  it('offers Axiom-maintained catalogs for OpenAI (API key) and ChatGPT (Codex login)', () => {
    expect(getAvailableImageModels('openai').map(m => m.id)).toEqual([
      'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'gpt-image-2', 'gpt-image-1.5', 'gpt-image-1', 'gpt-image-1-mini',
    ])
    expect(getAvailableImageModels('openai')[0]).toMatchObject({
      input: ['text', 'image'],
      output: ['image'],
      pricing: { textInput: 5, imageInput: 8, imageOutput: 30 },
    })
    expect(getAvailableImageModels('openai-codex')).toEqual([
      { id: 'gpt-image-2', name: 'GPT Image (ChatGPT subscription)', input: ['text', 'image'], output: ['image'] },
    ])
    expect(getImageApiForType('openai')).toBe('openai-images')
    expect(getImageApiForType('openai-codex')).toBe('openai-codex-images')
    expect(getImageApiForType('anthropic')).toBeUndefined()
  })

  it('classifies OpenAI image ids as image-only', () => {
    const isImageOnly = createImageOnlyModelIdMatcher('openai')
    expect(isImageOnly('gpt-image-2')).toBe(true)
    expect(isImageOnly('gpt-5.5')).toBe(false)
  })

  it('only offers image models for providers with an image backend', () => {
    expect(supportsImageModels('openrouter')).toBe(true)
    expect(supportsImageModels('openai')).toBe(true)
    expect(supportsImageModels('openai-codex')).toBe(true)
    expect(supportsImageModels('anthropic')).toBe(false)
    expect(supportsImageModels('custom-openai-completions')).toBe(false)
    expect(getAvailableImageModels('anthropic')).toEqual([])
  })

  it('classifies ids that exist only in the image catalog as image-only', () => {
    const isImageOnly = createImageOnlyModelIdMatcher('openrouter')
    expect(isImageOnly('recraft/recraft-v4.1')).toBe(true)
    expect(isImageOnly('openai/gpt-5-image-mini')).toBe(true)
    expect(isImageOnly('google/gemini-3-pro-image')).toBe(false)
    expect(isImageOnly('openrouter/auto')).toBe(false)
    expect(isImageOnly('qwen/qwen3.8-flash')).toBe(false)
    expect(createImageOnlyModelIdMatcher('anthropic')('recraft/recraft-v4.1')).toBe(false)
  })
})

describe('buildImageModel', () => {
  it('uses the catalog entry and the user display name', () => {
    const model = buildImageModel(openRouterProvider({ models: [{ id: 'recraft/recraft-v4.1-vector', name: 'Logos' }] }), 'recraft/recraft-v4.1-vector')
    expect(model).toMatchObject({
      id: 'recraft/recraft-v4.1-vector',
      name: 'Logos',
      api: 'openrouter-images',
      type: 'image',
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      output: ['image'],
    })
  })

  it('builds ids missing from the catalog on the provider image api', () => {
    const model = buildImageModel(openRouterProvider(), 'vendor/brand-new-image-model')
    expect(model).toMatchObject({
      id: 'vendor/brand-new-image-model',
      name: 'vendor/brand-new-image-model',
      api: 'openrouter-images',
      type: 'image',
      input: ['text', 'image'],
      output: ['image'],
    })
  })

  it('uses modalities stored when the model was added from a live list', () => {
    const model = buildImageModel(openRouterProvider({
      models: [{ id: 'vendor/text-and-image', input: ['text'], output: ['image', 'text'] }],
    }), 'vendor/text-and-image')
    expect(model).toMatchObject({ input: ['text'], output: ['image', 'text'] })
  })

  it('builds the ChatGPT image model on the Codex backend', () => {
    const model = buildImageModel(openRouterProvider({
      providerType: 'openai-codex',
      provider: 'openai-codex',
      type: 'openai-codex-responses',
      baseUrl: '',
      authMethod: 'oauth',
    }), 'gpt-image-2')
    expect(model).toMatchObject({
      api: 'openai-codex-images',
      provider: 'openai-codex',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
    })
  })

  it('rejects providers without image support', () => {
    expect(() => buildImageModel(openRouterProvider({ providerType: 'anthropic', name: 'Claude' }), 'x')).toThrow(/does not support image generation/)
  })
})

describe('getUsableImageModels', () => {
  it('returns enabled image models, but none for disabled or unsupported providers', () => {
    expect(getUsableImageModels(openRouterProvider({ enabledImageModels: ['recraft/recraft-v4.1'] }))).toEqual(['recraft/recraft-v4.1'])
    expect(getUsableImageModels(openRouterProvider({ enabledImageModels: ['recraft/recraft-v4.1'], disabled: true }))).toEqual([])
    expect(getUsableImageModels(openRouterProvider({ providerType: 'anthropic', enabledImageModels: ['x'] }))).toEqual([])
  })

  it('keeps image models out of the text model list', () => {
    const provider = openRouterProvider({ enabledModels: ['qwen/qwen3.8-flash'], enabledImageModels: ['recraft/recraft-v4.1'] })
    expect(getUsableModels(provider)).toEqual(['qwen/qwen3.8-flash'])
  })
})

describe('providers.json image model handling', () => {
  let tmpDir: string
  const originalDataDir = process.env.DATA_DIR

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-image-models-'))
    fs.mkdirSync(path.join(tmpDir, 'config'), { recursive: true })
    process.env.DATA_DIR = tmpDir
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    if (originalDataDir !== undefined) process.env.DATA_DIR = originalDataDir
    else delete process.env.DATA_DIR
  })

  function writeProviders(file: ProvidersFile): void {
    fs.writeFileSync(path.join(tmpDir, 'config', 'providers.json'), JSON.stringify(file, null, 2))
  }

  function readProvidersFromDisk(): ProvidersFile {
    return JSON.parse(fs.readFileSync(path.join(tmpDir, 'config', 'providers.json'), 'utf-8')) as ProvidersFile
  }

  it('moves image-only ids from enabledModels to enabledImageModels and persists it', () => {
    writeProviders({
      providers: [openRouterProvider({
        enabledModels: ['openai/gpt-5-image-mini', 'qwen/qwen3.8-flash', 'google/gemini-3.1-flash-image', 'recraft/recraft-v4.1'],
        disabledModels: ['recraft/recraft-v4.1'],
      })],
    })

    const provider = loadProviders().providers[0]!
    expect(provider.enabledModels).toEqual(['qwen/qwen3.8-flash'])
    expect(provider.enabledImageModels).toEqual(['openai/gpt-5-image-mini', 'google/gemini-3.1-flash-image', 'recraft/recraft-v4.1'])
    expect(provider.disabledModels).toBeUndefined()
    expect(readProvidersFromDisk().providers[0]!.enabledImageModels).toHaveLength(3)
  })

  it('migrates a provider whose only models are image models to zero text models', () => {
    writeProviders({
      providers: [openRouterProvider({ enabledModels: ['openai/gpt-5-image-mini', 'google/gemini-3.1-flash-image', 'recraft/recraft-v4.1'] })],
    })

    const provider = loadProviders().providers[0]!
    expect(provider.enabledModels).toEqual([])
    expect(getUsableModels(provider)).toEqual([])
    expect(getUsableImageModels(provider)).toEqual(['openai/gpt-5-image-mini', 'google/gemini-3.1-flash-image', 'recraft/recraft-v4.1'])
  })

  it('keeps ids that are also chat models and the active/fallback selection as text models', () => {
    writeProviders({
      providers: [openRouterProvider({ enabledModels: ['openai/gpt-5-image-mini', 'google/gemini-3-pro-image', 'recraft/recraft-v4.1'] })],
      activeProvider: OPENROUTER_ID,
      activeModel: 'openai/gpt-5-image-mini',
      fallbackProvider: OPENROUTER_ID,
      fallbackModel: 'recraft/recraft-v4.1',
    })

    const provider = loadProviders().providers[0]!
    expect(provider.enabledModels).toEqual(['openai/gpt-5-image-mini', 'google/gemini-3-pro-image', 'recraft/recraft-v4.1'])
    expect(provider.enabledImageModels).toBeUndefined()
  })

  it('leaves configs without image-only ids untouched on disk', () => {
    const original = {
      providers: [openRouterProvider({ enabledModels: ['qwen/qwen3.8-flash'] })],
    }
    writeProviders(original)
    const before = fs.readFileSync(path.join(tmpDir, 'config', 'providers.json'), 'utf-8')

    loadProviders()

    expect(fs.readFileSync(path.join(tmpDir, 'config', 'providers.json'), 'utf-8')).toBe(before)
  })

  it('updates, dedupes and clears enabledImageModels', () => {
    writeProviders({ providers: [openRouterProvider({ enabledModels: ['qwen/qwen3.8-flash'] })] })

    updateProvider(OPENROUTER_ID, { enabledImageModels: [' recraft/recraft-v4.1-vector ', 'recraft/recraft-v4.1-vector', ''] })
    expect(loadProviders().providers[0]!.enabledImageModels).toEqual(['recraft/recraft-v4.1-vector'])
    expect(loadProviders().providers[0]!.enabledModels).toEqual(['qwen/qwen3.8-flash'])

    updateProvider(OPENROUTER_ID, { enabledImageModels: [] })
    expect(loadProviders().providers[0]!.enabledImageModels).toBeUndefined()
  })

  it('rejects image models for providers without image support', () => {
    writeProviders({ providers: [openRouterProvider({ id: 'a-1', providerType: 'anthropic', provider: 'anthropic', name: 'Claude' })] })
    expect(() => updateProvider('a-1', { enabledImageModels: ['recraft/recraft-v4.1'] })).toThrow(/does not support image generation/)
  })

  it('drops image models when the provider type changes to another image backend or none', () => {
    writeProviders({ providers: [openRouterProvider({ enabledImageModels: ['recraft/recraft-v4.1'] })] })
    updateProvider(OPENROUTER_ID, { providerType: 'openai' })
    expect(loadProviders().providers[0]!.enabledImageModels).toBeUndefined()

    updateProvider(OPENROUTER_ID, { enabledImageModels: ['gpt-image-2'] })
    updateProvider(OPENROUTER_ID, { providerType: 'anthropic' })
    expect(loadProviders().providers[0]!.enabledImageModels).toBeUndefined()
  })

  it('stores and clears the output modalities of a model entry', () => {
    writeProviders({ providers: [openRouterProvider()] })
    updateProviderModel(OPENROUTER_ID, 'vendor/new', { name: 'New', input: ['text'], output: ['image', 'text'] })
    expect(loadProviders().providers[0]!.models).toEqual([{ id: 'vendor/new', name: 'New', input: ['text'], output: ['image', 'text'] }])

    updateProviderModel(OPENROUTER_ID, 'vendor/new', { output: null })
    expect(loadProviders().providers[0]!.models?.[0]).not.toHaveProperty('output')
  })

  it('derives the provider status from text models, ignoring image model results', () => {
    writeProviders({ providers: [openRouterProvider({ enabledModels: ['qwen/qwen3.8-flash'], enabledImageModels: ['recraft/recraft-v4.1'] })] })

    updateProviderStatus(OPENROUTER_ID, 'connected', 'qwen/qwen3.8-flash')
    updateProviderStatus(OPENROUTER_ID, 'error', 'recraft/recraft-v4.1')
    const provider = loadProviders().providers[0]!
    expect(provider.status).toBe('connected')
    expect(provider.modelStatuses?.['recraft/recraft-v4.1']).toBe('error')
  })

  it('derives the status of an image-only provider from its image models', () => {
    writeProviders({ providers: [openRouterProvider({ enabledModels: [], enabledImageModels: ['recraft/recraft-v4.1'] })] })

    updateProviderStatus(OPENROUTER_ID, 'error', 'recraft/recraft-v4.1')
    expect(loadProviders().providers[0]!.status).toBe('error')

    updateProviderStatus(OPENROUTER_ID, 'connected', 'recraft/recraft-v4.1')
    expect(loadProviders().providers[0]!.status).toBe('connected')
  })
})
