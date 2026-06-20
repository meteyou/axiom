import { describe, it, expect, afterEach, vi } from 'vitest'
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
  updateProviderModel,
  deleteProvider,
  setActiveProvider,
  updateProviderStatus,
  PROVIDER_TYPE_PRESETS,
  PROVIDER_TYPE_MODEL_OVERRIDES,
  getConfiguredPriceTable,
  applyTextVerbosity,
  applyTransport,
  buildStreamFn,
  presetSupportsTextVerbosity,
  presetSupportsTransport,
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

  it('updateProviderModel creates an entry with catalog defaults and applies description/cost patches', () => {
    setupTmpConfig({
      providers: [
        {
          id: 'kimi-id',
          name: 'Kimi',
          type: 'openai-completions',
          providerType: 'kimi',
          provider: 'moonshot',
          baseUrl: 'https://api.moonshot.ai/v1',
          apiKey: 'sk-kimi',
          defaultModel: 'kimi-k2.6',
          enabledModels: ['kimi-k2.6', 'kimi-latest'],
        },
      ],
    })

    // No models[] entry yet → created on the fly from PROVIDER_TYPE_MODEL_OVERRIDES.
    // Use a custom input price to ensure the shared catalog object is not mutated.
    const patched = updateProviderModel('kimi-id', 'kimi-k2.6', {
      description: 'Fast model for digests',
      cost: { input: 1.5, output: 2.5 },
    })
    // The module-level catalog default must stay untouched (no shared reference).
    const catalogDefault = PROVIDER_TYPE_MODEL_OVERRIDES.kimi?.find(m => m.id === 'kimi-k2.6')
    expect(catalogDefault?.cost?.input).toBe(0.6)
    const entry = patched.models?.find(m => m.id === 'kimi-k2.6')
    expect(entry).toBeDefined()
    expect(entry?.description).toBe('Fast model for digests')
    // Catalog defaults populated (contextWindow, reasoning) …
    expect(entry?.contextWindow).toBe(262_144)
    expect(entry?.reasoning).toBe(true)
    // … and the patched cost applied
    expect(entry?.cost?.input).toBe(1.5)
    expect(entry?.cost?.output).toBe(2.5)
    // Catalog cache cost preserved when not overridden
    expect(entry?.cost?.cacheRead).toBe(0.15)

    // Clearing the description removes it; cost stays
    const cleared = updateProviderModel('kimi-id', 'kimi-k2.6', { description: '   ' })
    const clearedEntry = cleared.models?.find(m => m.id === 'kimi-k2.6')
    expect(clearedEntry?.description).toBeUndefined()
    expect(clearedEntry?.cost?.input).toBe(1.5)

    // Unknown provider throws
    expect(() => updateProviderModel('no-such', 'kimi-k2.6', { description: 'x' })).toThrowError(
      'Provider not found: no-such',
    )
  })
})

describe('streamFn injection', () => {
  it('applyTextVerbosity returns opts unchanged when textVerbosity is undefined', () => {
    const opts = { temperature: 0.7 }
    expect(applyTextVerbosity(undefined, opts)).toBe(opts)
  })

  it('applyTextVerbosity merges textVerbosity into opts when set', () => {
    const opts = { temperature: 0.7 }
    const merged = applyTextVerbosity('medium', opts)
    expect(merged).toEqual({ temperature: 0.7, textVerbosity: 'medium' })
    // does not mutate the input
    expect(opts).toEqual({ temperature: 0.7 })
  })

  it('buildStreamFn forwards textVerbosity into streamSimple options when configured', async () => {
    const fakeStream = vi.fn().mockResolvedValue({ ok: true })
    const fn = buildStreamFn({ textVerbosity: 'medium' }, fakeStream as never)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await fn({ id: 'm' } as any, { messages: [] } as any, { temperature: 0.5 } as any)
    expect(fakeStream).toHaveBeenCalledTimes(1)
    const [, , opts] = fakeStream.mock.calls[0]!
    expect(opts).toEqual({ temperature: 0.5, textVerbosity: 'medium' })
  })

  it('buildStreamFn passes options through unchanged when no textVerbosity is set', async () => {
    const fakeStream = vi.fn().mockResolvedValue({ ok: true })
    const fn = buildStreamFn({}, fakeStream as never)
    const inputOpts = { temperature: 0.5 }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await fn({ id: 'm' } as any, { messages: [] } as any, inputOpts as any)
    const [, , opts] = fakeStream.mock.calls[0]!
    expect(opts).toBe(inputOpts) // identity — no spread when not needed
    expect(opts).not.toHaveProperty('textVerbosity')
  })

  it('applyTransport returns opts unchanged when transport is undefined', () => {
    const opts = { temperature: 0.7 }
    expect(applyTransport(undefined, opts)).toBe(opts)
  })

  it('applyTransport returns opts unchanged when transport is the default "sse"', () => {
    const opts = { temperature: 0.7 }
    // "sse" matches pi-ai's default — the spread would be a no-op, so we keep
    // identity for the common case to make the call site free of churn.
    expect(applyTransport('sse', opts)).toBe(opts)
  })

  it('applyTransport merges non-default transports into opts', () => {
    const opts = { temperature: 0.7 }
    const merged = applyTransport('websocket-cached', opts)
    expect(merged).toEqual({ temperature: 0.7, transport: 'websocket-cached' })
    // does not mutate the input
    expect(opts).toEqual({ temperature: 0.7 })
  })

  it('buildStreamFn forwards transport into streamSimple options when configured', async () => {
    const fakeStream = vi.fn().mockResolvedValue({ ok: true })
    const fn = buildStreamFn({ transport: 'websocket-cached' }, fakeStream as never)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await fn({ id: 'm' } as any, { messages: [] } as any, { temperature: 0.5 } as any)
    expect(fakeStream).toHaveBeenCalledTimes(1)
    const [, , opts] = fakeStream.mock.calls[0]!
    expect(opts).toEqual({ temperature: 0.5, transport: 'websocket-cached' })
  })

  it('buildStreamFn forwards both textVerbosity and transport when both configured', async () => {
    const fakeStream = vi.fn().mockResolvedValue({ ok: true })
    const fn = buildStreamFn(
      { textVerbosity: 'medium', transport: 'websocket' },
      fakeStream as never,
    )
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await fn({ id: 'm' } as any, { messages: [] } as any, { temperature: 0.5 } as any)
    const [, , opts] = fakeStream.mock.calls[0]!
    expect(opts).toEqual({
      temperature: 0.5,
      textVerbosity: 'medium',
      transport: 'websocket',
    })
  })

  it('buildStreamFn passes options through unchanged when transport is "sse" (default)', async () => {
    const fakeStream = vi.fn().mockResolvedValue({ ok: true })
    const fn = buildStreamFn({ transport: 'sse' }, fakeStream as never)
    const inputOpts = { temperature: 0.5 }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await fn({ id: 'm' } as any, { messages: [] } as any, inputOpts as any)
    const [, , opts] = fakeStream.mock.calls[0]!
    expect(opts).toBe(inputOpts) // identity — no spread when not needed
    expect(opts).not.toHaveProperty('transport')
  })

  it('presetSupportsTransport is true only for openai-codex-responses presets', () => {
    // Only the OpenAI Codex / Responses apiType currently honours `transport`
    // in pi-ai. Keeping this list explicit so a future provider gaining WS
    // support fails this assertion and forces a deliberate update.
    expect(presetSupportsTransport('openai-codex')).toBe(true)
    expect(presetSupportsTransport('openai')).toBe(false)
    expect(presetSupportsTransport('anthropic')).toBe(false)
    expect(presetSupportsTransport('github-copilot')).toBe(false)
    expect(presetSupportsTransport('ollama')).toBe(false)
  })
})

describe('textVerbosity persistence guard', () => {
  let tmpDir: string
  const originalDataDir = process.env.DATA_DIR

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
    if (originalDataDir !== undefined) process.env.DATA_DIR = originalDataDir
    else delete process.env.DATA_DIR
  })

  function setupEmpty(): void {
    tmpDir = path.join(os.tmpdir(), `axiom-tv-guard-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    const configDir = path.join(tmpDir, 'config')
    fs.mkdirSync(configDir, { recursive: true })
    fs.writeFileSync(
      path.join(configDir, 'providers.json'),
      JSON.stringify({ providers: [] }, null, 2),
      'utf-8',
    )
    process.env.DATA_DIR = tmpDir
  }

  it('addProvider drops textVerbosity when preset does not support it', () => {
    setupEmpty()
    const provider = addProvider({
      name: 'openai-noop',
      providerType: 'openai',
      apiKey: 'sk-1',
      defaultModel: 'gpt-4o',
      textVerbosity: 'medium',
    })
    expect(provider.textVerbosity).toBeUndefined()
  })

  it('updateProvider strips textVerbosity when switching to a non-supporting providerType', () => {
    setupEmpty()
    // Need a non-active provider so we can mutate freely without re-pointing active
    addProvider({ name: 'primary', providerType: 'openai', apiKey: 'sk-a', defaultModel: 'gpt-4o' })
    const codex = addProvider({
      name: 'codex',
      providerType: 'openai-codex',
      defaultModel: 'gpt-5-codex',
      textVerbosity: 'high',
    })
    // codex preset is OAuth + openai-codex-responses — textVerbosity is honoured
    expect(codex.textVerbosity).toBe('high')

    // Flip to a providerType that does not consume textVerbosity
    const updated = updateProvider(codex.id, { providerType: 'openai' })
    expect(updated.textVerbosity).toBeUndefined()
  })

  it('updateProvider clears textVerbosity when explicitly set to null', () => {
    setupEmpty()
    addProvider({ name: 'primary', providerType: 'openai', apiKey: 'sk-a', defaultModel: 'gpt-4o' })
    const codex = addProvider({
      name: 'codex',
      providerType: 'openai-codex',
      defaultModel: 'gpt-5-codex',
      textVerbosity: 'low',
    })
    expect(codex.textVerbosity).toBe('low')
    const updated = updateProvider(codex.id, { textVerbosity: null })
    expect(updated.textVerbosity).toBeUndefined()
  })

  it('updateProvider ignores textVerbosity on providers whose preset does not support it', () => {
    setupEmpty()
    const provider = addProvider({ name: 'primary', providerType: 'openai', apiKey: 'sk-a', defaultModel: 'gpt-4o' })
    const updated = updateProvider(provider.id, { textVerbosity: 'high' })
    expect(updated.textVerbosity).toBeUndefined()
  })
})

describe('transport persistence guard', () => {
  let tmpDir: string
  const originalDataDir = process.env.DATA_DIR

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
    if (originalDataDir !== undefined) process.env.DATA_DIR = originalDataDir
    else delete process.env.DATA_DIR
  })

  function setupEmpty(): void {
    tmpDir = path.join(os.tmpdir(), `axiom-tr-guard-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    const configDir = path.join(tmpDir, 'config')
    fs.mkdirSync(configDir, { recursive: true })
    fs.writeFileSync(
      path.join(configDir, 'providers.json'),
      JSON.stringify({ providers: [] }, null, 2),
      'utf-8',
    )
    process.env.DATA_DIR = tmpDir
  }

  it('addProvider persists transport on supported providerType (openai-codex)', () => {
    setupEmpty()
    const codex = addProvider({
      name: 'codex-ws',
      providerType: 'openai-codex',
      defaultModel: 'gpt-5-codex',
      transport: 'websocket-cached',
    })
    expect(codex.transport).toBe('websocket-cached')
  })

  it('addProvider drops transport when preset does not support it', () => {
    setupEmpty()
    const provider = addProvider({
      name: 'openai-noop',
      providerType: 'openai',
      apiKey: 'sk-1',
      defaultModel: 'gpt-4o',
      transport: 'websocket-cached',
    })
    expect(provider.transport).toBeUndefined()
  })

  it('addProvider drops transport when value is the default "sse"', () => {
    setupEmpty()
    const codex = addProvider({
      name: 'codex-sse',
      providerType: 'openai-codex',
      defaultModel: 'gpt-5-codex',
      transport: 'sse',
    })
    // We never persist the no-op default — absence == "sse".
    expect(codex.transport).toBeUndefined()
  })

  it('addProvider defaults transport to undefined (== sse) when not provided', () => {
    setupEmpty()
    const codex = addProvider({
      name: 'codex-default',
      providerType: 'openai-codex',
      defaultModel: 'gpt-5-codex',
    })
    expect(codex.transport).toBeUndefined()
  })

  it('updateProvider persists transport on supported provider', () => {
    setupEmpty()
    addProvider({ name: 'primary', providerType: 'openai', apiKey: 'sk-a', defaultModel: 'gpt-4o' })
    const codex = addProvider({
      name: 'codex',
      providerType: 'openai-codex',
      defaultModel: 'gpt-5-codex',
    })
    const updated = updateProvider(codex.id, { transport: 'websocket-cached' })
    expect(updated.transport).toBe('websocket-cached')
  })

  it('updateProvider strips transport when switching to a non-supporting providerType', () => {
    setupEmpty()
    addProvider({ name: 'primary', providerType: 'openai', apiKey: 'sk-a', defaultModel: 'gpt-4o' })
    const codex = addProvider({
      name: 'codex',
      providerType: 'openai-codex',
      defaultModel: 'gpt-5-codex',
      transport: 'websocket-cached',
    })
    expect(codex.transport).toBe('websocket-cached')

    // Flip to a providerType that does not consume transport
    const updated = updateProvider(codex.id, { providerType: 'openai' })
    expect(updated.transport).toBeUndefined()
  })

  it('updateProvider clears transport when explicitly set to null', () => {
    setupEmpty()
    addProvider({ name: 'primary', providerType: 'openai', apiKey: 'sk-a', defaultModel: 'gpt-4o' })
    const codex = addProvider({
      name: 'codex',
      providerType: 'openai-codex',
      defaultModel: 'gpt-5-codex',
      transport: 'websocket-cached',
    })
    expect(codex.transport).toBe('websocket-cached')
    const updated = updateProvider(codex.id, { transport: null })
    expect(updated.transport).toBeUndefined()
  })

  it('updateProvider clears transport when explicitly set to "sse" (the default)', () => {
    setupEmpty()
    addProvider({ name: 'primary', providerType: 'openai', apiKey: 'sk-a', defaultModel: 'gpt-4o' })
    const codex = addProvider({
      name: 'codex',
      providerType: 'openai-codex',
      defaultModel: 'gpt-5-codex',
      transport: 'websocket-cached',
    })
    const updated = updateProvider(codex.id, { transport: 'sse' })
    expect(updated.transport).toBeUndefined()
  })

  it('updateProvider ignores transport on providers whose preset does not support it', () => {
    setupEmpty()
    const provider = addProvider({ name: 'primary', providerType: 'openai', apiKey: 'sk-a', defaultModel: 'gpt-4o' })
    const updated = updateProvider(provider.id, { transport: 'websocket-cached' })
    expect(updated.transport).toBeUndefined()
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

  it('addProvider sets xai base URL and OpenAI-compatible api type', () => {
    setupEmpty()
    const provider = addProvider({
      name: 'Grok',
      providerType: 'xai',
      apiKey: 'xai-key',
      defaultModel: 'grok-4.3',
    })
    expect(provider.baseUrl).toBe('https://api.x.ai/v1')
    expect(provider.type).toBe('openai-completions')
    expect(provider.provider).toBe('xai')
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

  it('stores provider extra fields generically and masks secret entries', () => {
    setupEmpty()
    const created = addProvider({
      name: 'OpenCode Go',
      providerType: 'opencode-go',
      apiKey: 'oc-key',
      defaultModel: 'glm-5.1',
      extraFields: {
        workspaceId: ' workspace-1 ',
        authCookie: ' auth-cookie-1 ',
        unknown: 'ignored',
      },
    })

    const stored = loadProviders().providers.find(p => p.id === created.id)!
    expect(stored.extraFields).toEqual({
      workspaceId: 'workspace-1',
      authCookie: expect.any(String),
    })
    expect(stored.extraFields!.authCookie).not.toBe('auth-cookie-1')
    expect(decrypt(stored.extraFields!.authCookie)).toBe('auth-cookie-1')

    const decrypted = loadProvidersDecrypted().providers.find(p => p.id === created.id)!
    expect(decrypted.extraFields).toEqual({ workspaceId: 'workspace-1', authCookie: 'auth-cookie-1' })

    const masked = loadProvidersMasked().providers.find(p => p.id === created.id)!
    expect(masked.extraFields).toEqual({ workspaceId: 'workspace-1' })
    expect(masked.extraFieldsSet).toEqual({ authCookie: true })
  })

  it('keeps secret extra fields on blank update and clears blank non-secret fields', () => {
    setupEmpty()
    const created = addProvider({
      name: 'OpenCode Go',
      providerType: 'opencode-go',
      apiKey: 'oc-key',
      defaultModel: 'glm-5.1',
      extraFields: { workspaceId: 'workspace-1', authCookie: 'auth-cookie-1' },
    })

    updateProvider(created.id, { extraFields: { workspaceId: '', authCookie: '' } })
    expect(loadProvidersDecrypted().providers[0]!.extraFields).toEqual({ authCookie: 'auth-cookie-1' })

    updateProvider(created.id, { extraFields: { authCookie: 'auth-cookie-2' } })
    expect(loadProvidersDecrypted().providers[0]!.extraFields).toEqual({ authCookie: 'auth-cookie-2' })
  })

  it('clears provider extra fields when provider type changes', () => {
    setupEmpty()
    const created = addProvider({
      name: 'OpenCode Go',
      providerType: 'opencode-go',
      apiKey: 'oc-key',
      defaultModel: 'glm-5.1',
      extraFields: { workspaceId: 'workspace-1', authCookie: 'auth-cookie-1' },
    })

    updateProvider(created.id, { providerType: 'openai', defaultModel: 'gpt-4o', enabledModels: ['gpt-4o'] })

    const stored = loadProviders().providers.find(p => p.id === created.id)!
    expect(stored.extraFields).toBeUndefined()

    const masked = loadProvidersMasked().providers.find(p => p.id === created.id)!
    expect(masked.extraFields).toEqual({})
    expect(masked.extraFieldsSet).toEqual({})
  })

  it('omits stale unknown extra fields from masked providers', () => {
    setupEmpty()
    fs.writeFileSync(
      path.join(tmpDir, 'config', 'providers.json'),
      JSON.stringify({
        providers: [{
          id: 'stale-openai',
          name: 'Stale OpenAI',
          type: 'openai-completions',
          providerType: 'openai',
          provider: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          apiKey: encrypt('sk-test'),
          defaultModel: 'gpt-4o',
          extraFields: { workspaceId: 'workspace-1', authCookie: encrypt('auth-cookie-1') },
          status: 'untested',
          authMethod: 'api-key',
        }],
      }, null, 2),
      'utf-8',
    )

    const masked = loadProvidersMasked().providers[0]!
    expect(masked.extraFields).toEqual({})
    expect(masked.extraFieldsSet).toEqual({})
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
    expect(PROVIDER_TYPE_PRESETS).toHaveProperty('deepseek')
    expect(PROVIDER_TYPE_PRESETS).toHaveProperty('kimi')
    expect(PROVIDER_TYPE_PRESETS).toHaveProperty('minimax')
    expect(PROVIDER_TYPE_PRESETS).toHaveProperty('zai')
    expect(PROVIDER_TYPE_PRESETS).toHaveProperty('openai-compatible')
  })
})

describe('openai-compatible provider type', () => {
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

  function setupTmp(): void {
    tmpDir = path.join(os.tmpdir(), `axiom-openai-compat-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    fs.mkdirSync(path.join(tmpDir, 'config'), { recursive: true })
    process.env.DATA_DIR = tmpDir
  }

  it('preset is configured as a generic, BYO-URL, optional-key endpoint', () => {
    const preset = PROVIDER_TYPE_PRESETS['openai-compatible']
    expect(preset).toBeDefined()
    // Must use the OpenAI completions wire format so streaming/tool-calling
    // is identical to the regular `openai` provider type.
    expect(preset.apiType).toBe('openai-completions')
    expect(preset.authMethod).toBe('api-key')
    // Generic by design: URL is user-supplied, key is optional, and there is
    // no upstream catalog to fetch a model list from.
    expect(preset.urlEditable).toBe(true)
    expect(preset.requiresApiKey).toBe(false)
    expect(preset.piAiProvider).toBeNull()
    expect(preset.baseUrl).toBe('')
    // Label is used for the dropdown entry; the (custom) suffix is the
    // contract that distinguishes it from the regular `openai` preset.
    expect(preset.label.toLowerCase()).toContain('custom')
  })

  it('returns no catalog models (free-text input is expected)', () => {
    expect(getAvailableModels('openai-compatible')).toEqual([])
  })

  it('does not advertise textVerbosity support', () => {
    expect(presetSupportsTextVerbosity('openai-compatible')).toBe(false)
  })

  it('addProvider persists a user-supplied baseUrl, encrypts the key, and round-trips via decrypted load', () => {
    setupTmp()
    const created = addProvider({
      name: 'NVIDIA NIM',
      providerType: 'openai-compatible',
      baseUrl: 'https://integrate.api.nvidia.com/v1',
      apiKey: 'nvapi-secret-token',
      defaultModel: 'meta/llama-3.1-405b-instruct',
    })

    // Stored config should track exactly what the user typed (not a preset URL)
    expect(created.providerType).toBe('openai-compatible')
    expect(created.type).toBe('openai-completions')
    expect(created.provider).toBe('openai-compatible')
    expect(created.baseUrl).toBe('https://integrate.api.nvidia.com/v1')
    expect(created.defaultModel).toBe('meta/llama-3.1-405b-instruct')

    // On disk the API key must be encrypted, never plaintext
    const onDisk = loadProviders().providers[0]!
    expect(onDisk.apiKey).not.toBe('nvapi-secret-token')
    expect(onDisk.apiKey.length).toBeGreaterThan(0)
    expect(decrypt(onDisk.apiKey)).toBe('nvapi-secret-token')

    // The decrypted view (used by the runtime) must give the plaintext back
    const decryptedView = loadProvidersDecrypted().providers[0]!
    expect(decryptedView.apiKey).toBe('nvapi-secret-token')
    // baseUrl is treated as user-editable, so it must NOT be overridden by the empty preset value
    expect(decryptedView.baseUrl).toBe('https://integrate.api.nvidia.com/v1')
  })

  it('addProvider works without an API key (e.g. local LM Studio / vLLM)', () => {
    setupTmp()
    const created = addProvider({
      name: 'Local LM Studio',
      providerType: 'openai-compatible',
      baseUrl: 'http://localhost:1234/v1',
      defaultModel: 'qwen2.5-coder-32b',
    })

    expect(created.apiKey).toBe('')
    const onDisk = loadProviders().providers[0]!
    expect(onDisk.apiKey).toBe('')
  })

  it('buildModel returns a Model whose api/baseUrl come from the user-supplied config', () => {
    setupTmp()
    const provider = addProvider({
      name: 'NIM',
      providerType: 'openai-compatible',
      baseUrl: 'https://integrate.api.nvidia.com/v1',
      apiKey: 'nvapi-key',
      defaultModel: 'meta/llama-3.1-70b-instruct',
    })
    // Use the decrypted record so buildModel sees the user's plaintext key
    const decrypted = loadProvidersDecrypted().providers.find(p => p.id === provider.id)!
    const model = buildModel(decrypted)

    expect(model.id).toBe('meta/llama-3.1-70b-instruct')
    expect(model.api).toBe('openai-completions')
    expect(model.baseUrl).toBe('https://integrate.api.nvidia.com/v1')
    expect(model.provider).toBe('openai-compatible')
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

  it('returns models for openrouter provider type', () => {
    const models = getAvailableModels('openrouter')
    expect(models.length).toBeGreaterThan(0)
    expect(models[0]).toHaveProperty('id')
    expect(models[0]).toHaveProperty('name')
  })

  it('returns models for deepseek provider type', () => {
    const models = getAvailableModels('deepseek')
    expect(models.length).toBeGreaterThan(0)
    expect(models.map(m => m.id)).toContain('deepseek-v4-pro')
  })

  it('returns models for minimax provider type', () => {
    const models = getAvailableModels('minimax')
    expect(models.length).toBeGreaterThan(0)
    expect(models.some(m => m.id.startsWith('MiniMax-M2.'))).toBe(true)
  })

  it('returns Grok models for xai provider type', () => {
    const models = getAvailableModels('xai')
    expect(models.length).toBeGreaterThan(0)
    // The catalog is sourced from pi-ai's maintained `xai` provider, so we
    // assert on stable family ids rather than a frozen list.
    expect(models.every(m => m.id.startsWith('grok-'))).toBe(true)
    const ids = models.map(m => m.id)
    expect(ids).toContain('grok-3')
    expect(ids).toContain('grok-4.3')
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

  it('resolveModelTemperature applies pi-ai catalog Kimi K2 constraints for OpenCode presets', () => {
    expect(resolveModelTemperature({ providerType: 'opencode-go' as const }, 'kimi-k2.7-code', 0)).toBe(1)
    expect(resolveModelTemperature({ providerType: 'opencode-go' as const }, 'kimi-k2.6', 0)).toBe(1)
    expect(resolveModelTemperature({ providerType: 'opencode-zen' as const }, 'kimi-k2.5', 0)).toBe(1)
    expect(resolveModelTemperature({ providerType: 'opencode-go' as const }, 'glm-5.1', 0)).toBe(0)
  })

  it('presetSupportsTextVerbosity is true only for openai-codex-responses presets', () => {
    expect(presetSupportsTextVerbosity('openai-codex')).toBe(true)
    expect(presetSupportsTextVerbosity('openai')).toBe(false)
    expect(presetSupportsTextVerbosity('anthropic')).toBe(false)
    expect(presetSupportsTextVerbosity('github-copilot')).toBe(false)
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

describe('OpenCode Zen/Go catalog presets (sourced from pi-ai)', () => {
  const makeProvider = (providerType: 'opencode-go' | 'opencode-zen', defaultModel: string) => ({
    id: 'test-id',
    name: providerType,
    type: 'openai-completions',
    providerType,
    provider: providerType === 'opencode-zen' ? 'opencode' : 'opencode-go',
    baseUrl: PROVIDER_TYPE_PRESETS[providerType].baseUrl,
    apiKey: 'sk-test',
    defaultModel,
  })

  it('groups OpenCode Go under Subscription (api-key auth, subscription flag) but not Zen', () => {
    expect(PROVIDER_TYPE_PRESETS['opencode-go'].subscription).toBe(true)
    expect(PROVIDER_TYPE_PRESETS['opencode-go'].authMethod).toBe('api-key')
    expect(PROVIDER_TYPE_PRESETS['opencode-zen'].subscription).toBeUndefined()
  })

  it('getAvailableModels resolves the OpenCode Go catalog from pi-ai', () => {
    const ids = getAvailableModels('opencode-go').map(m => m.id)
    expect(ids.length).toBeGreaterThan(0)
    expect(ids).toContain('glm-5.1')
    expect(ids).toContain('kimi-k2.6')
  })

  it('getAvailableModels resolves the OpenCode Zen catalog from pi-ai', () => {
    const ids = getAvailableModels('opencode-zen').map(m => m.id)
    expect(ids.length).toBeGreaterThan(0)
    expect(ids).toContain('claude-opus-4-5')
    expect(ids).toContain('gemini-3.5-flash')
    expect(ids).toContain('gpt-5.5')
  })

  it('buildModel uses real per-token costs for OpenCode Go (not the old zeroed override)', () => {
    const model = buildModel(makeProvider('opencode-go', 'glm-5.1'))
    expect(model.id).toBe('glm-5.1')
    expect(model.api).toBe('openai-completions')
    expect(model.baseUrl).toBe('https://opencode.ai/zen/go/v1')
    expect(model.cost.input).toBeGreaterThan(0)
    expect(model.cost.output).toBeGreaterThan(0)
  })

  it('buildModel resolves per-model api + baseUrl for OpenCode Zen models across wire APIs', () => {
    const claude = buildModel(makeProvider('opencode-zen', 'claude-opus-4-5'))
    expect(claude.api).toBe('anthropic-messages')
    expect(claude.baseUrl).toContain('opencode.ai/zen')
    expect(claude.cost.input).toBeGreaterThan(0)

    const gemini = buildModel(makeProvider('opencode-zen', 'gemini-3.5-flash'))
    expect(gemini.api).toBe('google-generative-ai')

    const gpt = buildModel(makeProvider('opencode-zen', 'gpt-5.5'))
    expect(gpt.api).toBe('openai-responses')

    const glm = buildModel(makeProvider('opencode-zen', 'glm-5.1'))
    expect(glm.api).toBe('openai-completions')
  })

  it('does not change api-key providers without resolveModelsFromCatalog (openai stays single-api)', () => {
    const provider = {
      id: 'test-id',
      name: 'openai',
      type: 'openai-completions',
      providerType: 'openai' as const,
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      defaultModel: 'gpt-4o',
    }
    const model = buildModel(provider)
    expect(model.api).toBe('openai-completions')
    expect(model.baseUrl).toBe('https://api.openai.com/v1')
  })
})
