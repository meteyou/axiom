import { describe, expect, it } from 'vitest'
import { buildImageModelOptions, buildProviderModelOptions, getImageModelDisplayName, getModelDisplayName, listImageModels, listUsableImageModels } from './providerModelOptions'

const providers = [
  { id: 'a', name: 'A', enabledModels: ['a1', 'a2'], disabledModels: ['a2'] },
  { id: 'b', name: 'B', enabledModels: ['b1'], disabled: true },
]

describe('buildProviderModelOptions', () => {
  it('omits disabled providers and models by default', () => {
    expect(buildProviderModelOptions(providers).map(o => o.value)).toEqual(['a:a1'])
  })

  it('includes disabled providers and models when requested', () => {
    expect(buildProviderModelOptions(providers, { includeDisabled: true }).map(o => o.value))
      .toEqual(['a:a1', 'a:a2', 'b:b1'])
  })
})

describe('model display names', () => {
  const customGateway = {
    id: 'n',
    name: 'Custom Gateway',
    enabledModels: ['DeepSeek-V4-Flash', 'gemma'],
    models: [{ id: 'DeepSeek-V4-Flash', name: 'DeepSeek V4 Flash' }, { id: 'gemma', name: '  ' }],
  }

  it('prefers the configured name and falls back to the id', () => {
    expect(getModelDisplayName(customGateway, 'DeepSeek-V4-Flash')).toBe('DeepSeek V4 Flash')
    expect(getModelDisplayName(customGateway, 'gemma')).toBe('gemma')
    expect(getModelDisplayName(undefined, 'x')).toBe('x')
    expect(getModelDisplayName({ modelSpecs: { x: { name: 'Catalog X' } } }, 'x')).toBe('Catalog X')
    expect(getModelDisplayName({ models: [{ id: 'x', name: 'Mine' }], modelSpecs: { x: { name: 'Catalog X' } } }, 'x')).toBe('Mine')
  })

  it('labels select options with the display name but keeps the id as value', () => {
    expect(buildProviderModelOptions([customGateway])[0]).toEqual({
      value: 'n:DeepSeek-V4-Flash',
      label: 'Custom Gateway (DeepSeek V4 Flash)',
    })
  })
})

describe('image model options', () => {
  const openRouter = {
    id: 'or',
    name: 'OpenRouter',
    enabledModels: ['qwen/qwen3.8-flash'],
    enabledImageModels: ['recraft/recraft-v4.1-vector', 'google/gemini-3.1-flash-image'],
    models: [{ id: 'google/gemini-3.1-flash-image', name: 'Nano Banana' }],
    imageModelSpecs: { 'recraft/recraft-v4.1-vector': { name: 'Recraft V4.1 Vector' } },
  }

  it('keeps image models out of text model options', () => {
    expect(buildProviderModelOptions([openRouter]).map(o => o.value)).toEqual(['or:qwen/qwen3.8-flash'])
    expect(buildProviderModelOptions([openRouter], { includeDisabled: true }).map(o => o.value)).toEqual(['or:qwen/qwen3.8-flash'])
  })

  it('lists enabled image models of enabled providers with display names', () => {
    expect(buildImageModelOptions([openRouter, { ...openRouter, id: 'off', disabled: true }])).toEqual([
      { value: 'or:recraft/recraft-v4.1-vector', label: 'OpenRouter (Recraft V4.1 Vector)' },
      { value: 'or:google/gemini-3.1-flash-image', label: 'OpenRouter (Nano Banana)' },
    ])
    expect(getImageModelDisplayName(openRouter, 'unknown/model')).toBe('unknown/model')
  })

  it('lists usable image models with provider and description for the settings overview', () => {
    const described = {
      ...openRouter,
      models: [...openRouter.models, { id: 'recraft/recraft-v4.1-vector', description: ' Logos and icons as SVG. ' }],
    }
    expect(listUsableImageModels([described, { ...described, id: 'off', disabled: true }])).toEqual([
      {
        providerId: 'or',
        providerName: 'OpenRouter',
        modelId: 'recraft/recraft-v4.1-vector',
        displayName: 'Recraft V4.1 Vector',
        description: 'Logos and icons as SVG.',
        disabled: false,
      },
      {
        providerId: 'or',
        providerName: 'OpenRouter',
        modelId: 'google/gemini-3.1-flash-image',
        displayName: 'Nano Banana',
        description: '',
        disabled: false,
      },
    ])
  })

  it('keeps disabled image models in the overview but out of usable lists and options', () => {
    const partlyDisabled = { ...openRouter, disabledImageModels: ['recraft/recraft-v4.1-vector'] }
    expect(listImageModels([partlyDisabled]).map(e => [e.modelId, e.disabled])).toEqual([
      ['recraft/recraft-v4.1-vector', true],
      ['google/gemini-3.1-flash-image', false],
    ])
    expect(listUsableImageModels([partlyDisabled]).map(e => e.modelId)).toEqual(['google/gemini-3.1-flash-image'])
    expect(buildImageModelOptions([partlyDisabled]).map(o => o.value)).toEqual(['or:google/gemini-3.1-flash-image'])
  })
})
