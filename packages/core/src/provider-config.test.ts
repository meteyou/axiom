import { describe, it, expect, afterEach } from 'vitest'
import {
  loadProviders,
  loadProvidersDecrypted,
  loadProvidersMasked,
  getActiveProvider,
  getFallbackProvider,
  setFallbackProvider,
  clearFallbackProvider,
  getAvailableModels,
  buildModel,
  estimateCost,
  resolveModelTemperature,
  addProvider,
  updateProvider,
  deleteProvider,
  setActiveProvider,
  updateProviderStatus,
  PROVIDER_TYPE_PRESETS,
  getConfiguredPriceTable,
} from './provider-config.js'
import { encrypt, decrypt, maskApiKey } from './encryption.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

describe('provider-config', () => {
  let tmpDir: string
  const originalDataDir = process.env.DATA_DIR

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
    if (originalDataDir !== undefined) {
      process.env.DATA_DIR = originalDataDir
    } else {
      delete process.env.DATA_DIR
    }
  })

  function setupTmpConfig(providersContent?: object): void {
    tmpDir = path.join(os.tmpdir(), `axiom-provider-test-${Date.now()}`)
    const configDir = path.join(tmpDir, 'config')
    fs.mkdirSync(configDir, { recursive: true })
    if (providersContent) {
      fs.writeFileSync(
        path.join(configDir, 'providers.json'),
        JSON.stringify(providersContent, null, 2),
        'utf-8',
      )
    }
    process.env.DATA_DIR = tmpDir
  }

  it('loadProviders returns empty providers when file does not exist', () => {
    tmpDir = path.join(os.tmpdir(), `axiom-provider-test-${Date.now()}`)
    process.env.DATA_DIR = tmpDir
    const result = loadProviders()
    expect(result.providers).toEqual([])
  })

  it('loadProviders reads providers.json correctly', () => {
    setupTmpConfig({
      providers: [
        {
          id: 'test-id-1',
          name: 'my-openai',
          type: 'openai-completions',
          providerType: 'openai',
          provider: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          apiKey: 'sk-test',
          defaultModel: 'gpt-4o',
        },
      ],
    })

    const result = loadProviders()
    expect(result.providers).toHaveLength(1)
    expect(result.providers[0].name).toBe('my-openai')
    expect(result.providers[0].apiKey).toBe('sk-test')
  })

  it('getActiveProvider returns null when no providers configured', () => {
    setupTmpConfig({ providers: [] })
    expect(getActiveProvider()).toBeNull()
  })

  it('getActiveProvider returns first provider by default', () => {
    setupTmpConfig({
      providers: [
        { id: 'id-1', name: 'first', type: 'openai-completions', providerType: 'openai', provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-1', defaultModel: 'gpt-4o' },
        { id: 'id-2', name: 'second', type: 'anthropic-messages', providerType: 'anthropic', provider: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'sk-2', defaultModel: 'claude-3-5-sonnet-20241022' },
      ],
    })

    const active = getActiveProvider()
    expect(active?.name).toBe('first')
  })

  it('getActiveProvider respects activeProvider field', () => {
    setupTmpConfig({
      providers: [
        { id: 'id-1', name: 'first', type: 'openai-completions', providerType: 'openai', provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-1', defaultModel: 'gpt-4o' },
        { id: 'id-2', name: 'second', type: 'anthropic-messages', providerType: 'anthropic', provider: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'sk-2', defaultModel: 'claude-3-5-sonnet-20241022' },
      ],
      activeProvider: 'id-2',
    })

    const active = getActiveProvider()
    expect(active?.name).toBe('second')
  })

  it('buildModel creates a valid Model object', () => {
    const provider = {
      id: 'test-id',
      name: 'test',
      type: 'openai-completions',
      providerType: 'openai' as const,
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      defaultModel: 'gpt-4o',
    }

    const model = buildModel(provider)
    expect(model.id).toBe('gpt-4o')
    expect(model.api).toBe('openai-completions')
    expect(model.provider).toBe('openai')
    expect(model.baseUrl).toBe('https://api.openai.com/v1')
    expect(model.cost.input).toBe(2.50)
    expect(model.cost.output).toBe(10.00)
  })

  it('buildModel uses configured settings price table as fallback', () => {
    setupTmpConfig()
    fs.writeFileSync(
      path.join(tmpDir, 'config', 'settings.json'),
      JSON.stringify({ tokenPriceTable: { 'custom-priced-model': { input: 4.25, output: 12.5 } } }, null, 2),
      'utf-8',
    )

    const provider = {
      id: 'test-id',
      name: 'test',
      type: 'openai-completions',
      providerType: 'openai' as const,
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      defaultModel: 'custom-priced-model',
    }

    const priceTable = getConfiguredPriceTable()
    const model = buildModel(provider)
    expect(priceTable['custom-priced-model'].input).toBe(4.25)
    expect(model.cost.input).toBe(4.25)
    expect(model.cost.output).toBe(12.5)
  })

  it('buildModel uses model config overrides', () => {
    const provider = {
      id: 'test-id',
      name: 'test',
      type: 'openai-completions',
      providerType: 'openai' as const,
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      defaultModel: 'custom-model',
      models: [
        {
          id: 'custom-model',
          name: 'Custom Model',
          contextWindow: 256000,
          maxTokens: 32768,
          reasoning: true,
          cost: { input: 5.0, output: 15.0, cacheRead: 1.0, cacheWrite: 2.0 },
        },
      ],
    }

    const model = buildModel(provider)
    expect(model.id).toBe('custom-model')
    expect(model.name).toBe('Custom Model')
    expect(model.contextWindow).toBe(256000)
    expect(model.maxTokens).toBe(32768)
    expect(model.reasoning).toBe(true)
    expect(model.cost.input).toBe(5.0)
    expect(model.cost.cacheRead).toBe(1.0)
  })

  it('buildModel allows overriding model ID', () => {
    const provider = {
      id: 'test-id',
      name: 'test',
      type: 'openai-completions',
      providerType: 'openai' as const,
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      defaultModel: 'gpt-4o',
    }

    const model = buildModel(provider, 'gpt-4o-mini')
    expect(model.id).toBe('gpt-4o-mini')
    expect(model.cost.input).toBe(0.15)
  })

  it('estimateCost calculates correctly', () => {
    const model = buildModel({
      id: 'test-id',
      name: 'test',
      type: 'openai-completions',
      providerType: 'openai' as const,
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      defaultModel: 'gpt-4o',
    })

    const cost = estimateCost(model, 1000, 500)
    expect(cost).toBeCloseTo(0.0075, 6)
  })

  it('estimateCost includes cache costs', () => {
    const provider = {
      id: 'test-id',
      name: 'test',
      type: 'openai-completions',
      providerType: 'openai' as const,
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      defaultModel: 'custom',
      models: [
        {
          id: 'custom',
          cost: { input: 10.0, output: 30.0, cacheRead: 2.5, cacheWrite: 5.0 },
        },
      ],
    }

    const model = buildModel(provider)
    const cost = estimateCost(model, 1000, 500, 2000, 1000)
    expect(cost).toBeCloseTo(0.035, 6)
  })
})

describe('encryption', () => {
  it('encrypt/decrypt roundtrip works', () => {
    const plaintext = 'sk-test-api-key-12345'
    const encrypted = encrypt(plaintext)
    expect(encrypted).not.toBe(plaintext)
    const decrypted = decrypt(encrypted)
    expect(decrypted).toBe(plaintext)
  })

  it('maskApiKey masks correctly', () => {
    expect(maskApiKey('sk-1234567890abcdef')).toBe('sk-1••••••••cdef')
    expect(maskApiKey('short')).toBe('••••••••')
    expect(maskApiKey('12345678')).toBe('••••••••')
    expect(maskApiKey('123456789')).toBe('1234••••••••6789')
  })
})

describe('provider CRUD', () => {
  let tmpDir: string
  const originalDataDir = process.env.DATA_DIR

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
    if (originalDataDir !== undefined) {
      process.env.DATA_DIR = originalDataDir
    } else {
      delete process.env.DATA_DIR
    }
  })

  function setupEmpty(): void {
    tmpDir = path.join(os.tmpdir(), `axiom-provider-crud-${Date.now()}`)
    const configDir = path.join(tmpDir, 'config')
    fs.mkdirSync(configDir, { recursive: true })
    fs.writeFileSync(
      path.join(configDir, 'providers.json'),
      JSON.stringify({ providers: [] }, null, 2),
      'utf-8',
    )
    process.env.DATA_DIR = tmpDir
  }

  it('addProvider creates a provider with encrypted API key', () => {
    setupEmpty()

    const provider = addProvider({
      name: 'My OpenAI',
      providerType: 'openai',
      apiKey: 'sk-test123',
      defaultModel: 'gpt-4o',
    })

    expect(provider.id).toBeDefined()
    expect(provider.name).toBe('My OpenAI')
    expect(provider.type).toBe('openai-completions')
    expect(provider.provider).toBe('openai')
    expect(provider.baseUrl).toBe('https://api.openai.com/v1')
    expect(provider.status).toBe('untested')

    // API key should be encrypted in the stored file
    const file = loadProviders()
    expect(file.providers[0].apiKey).not.toBe('sk-test123')

    // But loadProvidersDecrypted should decrypt it
    const decrypted = loadProvidersDecrypted()
    expect(decrypted.providers[0].apiKey).toBe('sk-test123')

    // First provider should be auto-activated
    expect(file.activeProvider).toBe(provider.id)
  })

  it('addProvider uses type preset base URL', () => {
    setupEmpty()
    const provider = addProvider({
      name: 'Kimi',
      providerType: 'kimi',
      apiKey: 'sk-kimi',
      defaultModel: 'moonshot-v1-8k',
    })
    expect(provider.baseUrl).toBe('https://api.moonshot.ai/v1')
  })

  it('addProvider rejects duplicate name', () => {
    setupEmpty()
    addProvider({ name: 'test', providerType: 'openai', apiKey: 'sk-1', defaultModel: 'gpt-4o' })
    expect(() => addProvider({ name: 'test', providerType: 'openai', apiKey: 'sk-2', defaultModel: 'gpt-4o' }))
      .toThrow('already exists')
  })

  it('addProvider rejects invalid provider type', () => {
    setupEmpty()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => addProvider({ name: 'test', providerType: 'invalid' as any, apiKey: 'sk-1', defaultModel: 'gpt-4o' }))
      .toThrow('Unknown provider type')
  })

  it('updateProvider updates fields', () => {
    setupEmpty()
    const provider = addProvider({ name: 'test', providerType: 'openai', apiKey: 'sk-1', defaultModel: 'gpt-4o' })

    const updated = updateProvider(provider.id, { name: 'Updated Name', defaultModel: 'gpt-4o-mini' })
    expect(updated.name).toBe('Updated Name')
    expect(updated.defaultModel).toBe('gpt-4o-mini')
    expect(updated.status).toBe('untested') // reset on update
  })

  it('updateProvider throws on not found', () => {
    setupEmpty()
    expect(() => updateProvider('nonexistent', { name: 'test' })).toThrow('not found')
  })

  it('deleteProvider removes provider', () => {
    setupEmpty()
    const p1 = addProvider({ name: 'first', providerType: 'openai', apiKey: 'sk-1', defaultModel: 'gpt-4o' })
    const p2 = addProvider({ name: 'second', providerType: 'anthropic', apiKey: 'sk-2', defaultModel: 'claude-3-5-sonnet-20241022' })

    // p1 is active (first added), delete p2
    deleteProvider(p2.id)
    const file = loadProviders()
    expect(file.providers).toHaveLength(1)
    expect(file.providers[0].id).toBe(p1.id)
  })

  it('deleteProvider cannot delete active provider', () => {
    setupEmpty()
    const p1 = addProvider({ name: 'first', providerType: 'openai', apiKey: 'sk-1', defaultModel: 'gpt-4o' })
    expect(() => deleteProvider(p1.id)).toThrow('Cannot delete the active provider')
  })

  it('setActiveProvider changes active provider', () => {
    setupEmpty()
    const p1 = addProvider({ name: 'first', providerType: 'openai', apiKey: 'sk-1', defaultModel: 'gpt-4o' })
    const p2 = addProvider({ name: 'second', providerType: 'anthropic', apiKey: 'sk-2', defaultModel: 'claude-3-5-sonnet-20241022' })

    expect(loadProviders().activeProvider).toBe(p1.id)

    setActiveProvider(p2.id)
    expect(loadProviders().activeProvider).toBe(p2.id)
  })

  it('updateProviderStatus updates status', () => {
    setupEmpty()
    const provider = addProvider({ name: 'test', providerType: 'openai', apiKey: 'sk-1', defaultModel: 'gpt-4o' })

    updateProviderStatus(provider.id, 'connected')
    const file = loadProviders()
    expect(file.providers[0].status).toBe('connected')
  })

  it('loadProvidersMasked returns masked keys and empty apiKey', () => {
    setupEmpty()
    addProvider({ name: 'test', providerType: 'openai', apiKey: 'sk-test1234567890', defaultModel: 'gpt-4o' })

    const masked = loadProvidersMasked()
    expect(masked.providers[0].apiKey).toBe('')
    expect(masked.providers[0].apiKeyMasked).toContain('••••••••')
    expect(masked.providers[0].apiKeyMasked).not.toContain('sk-test1234567890')
  })

  it('setFallbackProvider sets the fallback provider', () => {
    setupEmpty()
    addProvider({ name: 'primary', providerType: 'openai', apiKey: 'sk-1', defaultModel: 'gpt-4o' })
    const p2 = addProvider({ name: 'fallback', providerType: 'anthropic', apiKey: 'sk-2', defaultModel: 'claude-3-5-sonnet-20241022' })

    setFallbackProvider(p2.id)
    const file = loadProviders()
    expect(file.fallbackProvider).toBe(p2.id)
  })

  it('getFallbackProvider returns the decrypted fallback provider config', () => {
    setupEmpty()
    addProvider({ name: 'primary', providerType: 'openai', apiKey: 'sk-1', defaultModel: 'gpt-4o' })
    const p2 = addProvider({ name: 'fallback', providerType: 'anthropic', apiKey: 'sk-fb-key', defaultModel: 'claude-3-5-sonnet-20241022' })

    setFallbackProvider(p2.id)
    const fb = getFallbackProvider()
    expect(fb).not.toBeNull()
    expect(fb!.id).toBe(p2.id)
    expect(fb!.name).toBe('fallback')
    expect(fb!.apiKey).toBe('sk-fb-key') // decrypted
  })

  it('getFallbackProvider returns null when no fallback set', () => {
    setupEmpty()
    addProvider({ name: 'primary', providerType: 'openai', apiKey: 'sk-1', defaultModel: 'gpt-4o' })
    expect(getFallbackProvider()).toBeNull()
  })

  it('setFallbackProvider rejects non-existent provider', () => {
    setupEmpty()
    addProvider({ name: 'primary', providerType: 'openai', apiKey: 'sk-1', defaultModel: 'gpt-4o' })
    expect(() => setFallbackProvider('nonexistent')).toThrow('not found')
  })

  it('setFallbackProvider rejects active provider with same model', () => {
    setupEmpty()
    const p1 = addProvider({ name: 'primary', providerType: 'openai', apiKey: 'sk-1', defaultModel: 'gpt-4o' })
    expect(() => setFallbackProvider(p1.id)).toThrow('Fallback cannot be the same provider and model as the active selection')
  })

  it('clearFallbackProvider removes the fallback provider setting', () => {
    setupEmpty()
    addProvider({ name: 'primary', providerType: 'openai', apiKey: 'sk-1', defaultModel: 'gpt-4o' })
    const p2 = addProvider({ name: 'fallback', providerType: 'anthropic', apiKey: 'sk-2', defaultModel: 'claude-3-5-sonnet-20241022' })

    setFallbackProvider(p2.id)
    expect(loadProviders().fallbackProvider).toBe(p2.id)

    clearFallbackProvider()
    expect(loadProviders().fallbackProvider).toBeUndefined()
    expect(getFallbackProvider()).toBeNull()
  })

  it('PROVIDER_TYPE_PRESETS has all required types', () => {
    expect(PROVIDER_TYPE_PRESETS).toHaveProperty('openai')
    expect(PROVIDER_TYPE_PRESETS).toHaveProperty('anthropic')
    expect(PROVIDER_TYPE_PRESETS).toHaveProperty('ollama')
    // Legacy aliases still exist for migration
    expect(PROVIDER_TYPE_PRESETS).toHaveProperty('ollama-local')
    expect(PROVIDER_TYPE_PRESETS).toHaveProperty('ollama-cloud')
    expect(PROVIDER_TYPE_PRESETS).toHaveProperty('openrouter')
    expect(PROVIDER_TYPE_PRESETS).toHaveProperty('kimi')
    expect(PROVIDER_TYPE_PRESETS).toHaveProperty('zai')
  })
})

describe('getAvailableModels', () => {
  it('returns models for openai provider type', () => {
    const models = getAvailableModels('openai')
    expect(models.length).toBeGreaterThan(0)
    expect(models[0]).toHaveProperty('id')
    expect(models[0]).toHaveProperty('name')
    const gpt4o = models.find(m => m.id === 'gpt-4o')
    expect(gpt4o).toBeDefined()
    expect(gpt4o!.name).toBe('GPT-4o')
  })

  it('returns models for anthropic provider type', () => {
    const models = getAvailableModels('anthropic')
    expect(models.length).toBeGreaterThan(0)
    const sonnet = models.find(m => m.id.includes('sonnet'))
    expect(sonnet).toBeDefined()
  })

  it('returns models for zai provider type', () => {
    const models = getAvailableModels('zai')
    expect(models.length).toBeGreaterThan(0)
    const glm = models.find(m => m.id.startsWith('glm-'))
    expect(glm).toBeDefined()
  })

  it('returns empty array for ollama (no pi-ai mapping)', () => {
    const models = getAvailableModels('ollama')
    expect(models).toEqual([])
  })

  it('returns empty array for openrouter (no pi-ai mapping)', () => {
    const models = getAvailableModels('openrouter')
    expect(models).toEqual([])
  })

  it('returns Moonshot platform models for kimi (local override, not pi-ai)', () => {
    const models = getAvailableModels('kimi')
    const ids = models.map(m => m.id)
    // The newly tracked K2 family must be present
    expect(ids).toContain('kimi-k2.6')
    expect(ids).toContain('kimi-k2.5')
    expect(ids).toContain('kimi-k2-0905-preview')
    expect(ids).toContain('kimi-k2-0711-preview')
    expect(ids).toContain('kimi-k2-turbo-preview')
    expect(ids).toContain('kimi-k2-thinking')
    expect(ids).toContain('kimi-k2-thinking-turbo')
    // pi-ai's kimi-coding-only ids must NOT leak through
    expect(ids).not.toContain('kimi-for-coding')
  })

  it('resolveModelTemperature forces temperature=1 for Kimi K2 thinking models', () => {
    const provider = {
      providerType: 'kimi' as const,
    }
    // Reasoning-constrained models must override requested temperature
    expect(resolveModelTemperature(provider, 'kimi-k2.6', 0)).toBe(1)
    expect(resolveModelTemperature(provider, 'kimi-k2.5', 0.3)).toBe(1)
    expect(resolveModelTemperature(provider, 'kimi-k2-thinking', 0)).toBe(1)
    expect(resolveModelTemperature(provider, 'kimi-k2-thinking-turbo', 0)).toBe(1)
    // Non-reasoning previews keep the caller's temperature
    expect(resolveModelTemperature(provider, 'kimi-k2-0905-preview', 0)).toBe(0)
    expect(resolveModelTemperature(provider, 'kimi-k2-turbo-preview', 0.5)).toBe(0.5)
    // Unknown model id passes through unchanged
    expect(resolveModelTemperature(provider, 'some-other-model', 0.7)).toBe(0.7)
  })

  it('resolveModelTemperature respects per-provider models[].fixedTemperature override', () => {
    const provider = {
      providerType: 'openai' as const,
      models: [{ id: 'gpt-custom', fixedTemperature: 0.42 }],
    }
    expect(resolveModelTemperature(provider, 'gpt-custom', 0)).toBe(0.42)
    expect(resolveModelTemperature(provider, 'gpt-4o', 0.8)).toBe(0.8)
  })

  it('buildModel picks up metadata from override catalog for kimi', () => {
    const provider = {
      id: 'test-id',
      name: 'kimi',
      type: 'openai-completions',
      providerType: 'kimi' as const,
      provider: 'moonshot',
      baseUrl: 'https://api.moonshot.ai/v1',
      apiKey: 'sk-test',
      defaultModel: 'kimi-k2-thinking',
    }
    const model = buildModel(provider)
    expect(model.id).toBe('kimi-k2-thinking')
    expect(model.name).toBe('Kimi K2 Thinking')
    expect(model.contextWindow).toBe(262_144)
    expect(model.reasoning).toBe(true)
    expect(model.cost.input).toBe(0.6)
    expect(model.cost.output).toBe(2.5)
    expect(model.cost.cacheRead).toBe(0.15)
    expect(model.api).toBe('openai-completions')
    expect(model.baseUrl).toBe('https://api.moonshot.ai/v1')
  })
})
