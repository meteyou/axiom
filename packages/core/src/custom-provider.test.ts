import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const { completeSimple } = vi.hoisted(() => ({ completeSimple: vi.fn() }))
vi.mock('./pi-models.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./pi-models.js')>()
  return { ...actual, completeSimple }
})

import { addProvider, buildModel, loadProviders, updateProvider } from './provider-config.js'
import { performProviderHealthCheck } from './provider-health.js'
import { validateModelCompat } from './contracts/providers.js'

describe('validateModelCompat', () => {
  it('accepts known options and unwraps a pasted provider entry', () => {
    expect(validateModelCompat('openai-completions', { compat: { thinkingFormat: 'qwen', supportsDeveloperRole: false } }))
      .toEqual({ ok: true, value: { thinkingFormat: 'qwen', supportsDeveloperRole: false } })
    expect(validateModelCompat('anthropic-messages', { allowedFallbackModels: [], supportsTemperature: false }).ok).toBe(true)
  })

  it('rejects unknown options, wrong value types and invalid enum values', () => {
    const unknown = validateModelCompat('openai-responses', { thinkingFormat: 'qwen' })
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.error).toContain('not supported for openai-responses')

    const wrongType = validateModelCompat('openai-completions', { supportsStore: 'no' })
    expect(!wrongType.ok && wrongType.error).toBe('compat.supportsStore must be a boolean')

    const badEnum = validateModelCompat('openai-completions', { thinkingFormat: 'reasoning_effort' })
    expect(!badEnum.ok && badEnum.error).toContain('compat.thinkingFormat must be one of "openai"')

    expect(validateModelCompat('openai-completions', [1]).ok).toBe(false)
  })
})

describe('custom provider api type and compat', () => {
  let tmpDir: string
  const originalDataDir = process.env.DATA_DIR

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-custom-provider-'))
    process.env.DATA_DIR = tmpDir
    completeSimple.mockReset()
  })

  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = originalDataDir
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function createCustom(
    providerType: 'custom-openai-completions' | 'custom-openai-responses' | 'custom-anthropic-messages' = 'custom-openai-completions',
    compat?: Record<string, unknown> | null,
  ) {
    return addProvider({
      name: 'Gateway',
      providerType,
      baseUrl: 'https://llm.example.com/v1',
      apiKey: 'sk-test',
      enabledModels: ['model-a'],
      compat,
    })
  }

  it('builds models with the preset api and the provider compat options', () => {
    const provider = createCustom('custom-openai-completions', { supportsDeveloperRole: false, maxTokensField: 'max_tokens' })
    expect(provider.type).toBe('openai-completions')

    const model = buildModel(provider, 'model-a')
    expect(model.api).toBe('openai-completions')
    expect(model.provider).toBe('custom')
    expect(model.compat).toEqual({ supportsDeveloperRole: false, maxTokensField: 'max_tokens' })
  })

  it('supports the anthropic messages api', () => {
    const provider = createCustom('custom-anthropic-messages', { supportsTemperature: false })
    const model = buildModel(provider, 'model-a')
    expect(model.api).toBe('anthropic-messages')
    expect(model.compat).toEqual({ supportsTemperature: false })
    expect(model.headers).toBeUndefined()
  })

  it('validates compat against the preset api', () => {
    expect(() => createCustom('custom-openai-completions', { thinkingFormat: 'nope' })).toThrow('compat.thinkingFormat')
    expect(() => createCustom('custom-openai-responses', { thinkingFormat: 'qwen' })).toThrow('not supported for openai-responses')
  })

  it('never stores compat on regular presets', () => {
    const provider = addProvider({
      name: 'OpenAI', providerType: 'openai', apiKey: 'sk', enabledModels: ['gpt-5'], compat: { supportsStore: false },
    })
    expect(provider.compat).toBeUndefined()
  })

  it('switching the custom preset drops compat unless it is resent', () => {
    const provider = createCustom('custom-openai-completions', { supportsStore: false })

    expect(updateProvider(provider.id, { name: 'Gateway 2' }).compat).toEqual({ supportsStore: false })

    const switched = updateProvider(provider.id, { providerType: 'custom-openai-responses' })
    expect(switched.type).toBe('openai-responses')
    expect(switched.compat).toBeUndefined()

    const withCompat = updateProvider(provider.id, { providerType: 'custom-anthropic-messages', compat: { supportsTemperature: false } })
    expect(withCompat).toMatchObject({ type: 'anthropic-messages', compat: { supportsTemperature: false } })

    expect(updateProvider(provider.id, { compat: null }).compat).toBeUndefined()
  })

  it('migrates the former openai-compatible preset to custom-openai-completions', () => {
    const file = path.join(tmpDir, 'config', 'providers.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({
      providers: [{
        id: 'legacy', name: 'Legacy', type: 'openai-completions', providerType: 'openai-compatible',
        provider: 'openai-compatible', baseUrl: 'https://llm.example.com/v1', apiKey: '', enabledModels: ['m'],
      }],
    }))

    const migrated = loadProviders().providers[0]!
    expect(migrated).toMatchObject({ providerType: 'custom-openai-completions', provider: 'custom', type: 'openai-completions' })
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).providers[0].providerType).toBe('custom-openai-completions')
  })

  it('health-checks custom providers through pi-ai with a system prompt', async () => {
    const provider = createCustom('custom-openai-responses')
    completeSimple.mockResolvedValue({ stopReason: 'stop', content: [{ type: 'text', text: 'OK' }] })

    const result = await performProviderHealthCheck(provider)

    expect(result.status).not.toBe('down')
    const [model, context] = completeSimple.mock.calls[0]!
    expect(model.api).toBe('openai-responses')
    expect(context.systemPrompt).toBeTruthy()
  })
})
