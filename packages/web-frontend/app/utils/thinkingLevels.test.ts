import { describe, expect, it } from 'vitest'
import { buildThinkingLevelSelectOptions, findModelSpecByComposite, getThinkingLevelChoices } from './thinkingLevels'

const deepseek = {
  name: 'DeepSeek',
  contextWindow: 1_048_576,
  maxTokens: 393_216,
  reasoning: true,
  input: ['text' as const],
  thinkingLevelMap: { minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max' },
}

const providers = [
  { id: 'custom-gateway', enabledModels: ['ds', 'plain'], modelSpecs: { ds: deepseek } },
]

describe('getThinkingLevelChoices', () => {
  it('offers only the levels the model supports', () => {
    expect(getThinkingLevelChoices(deepseek, 'high')).toEqual({ levels: ['off', 'low', 'high', 'max'], effective: 'high' })
  })

  it('reports the clamped level for an unsupported setting', () => {
    expect(getThinkingLevelChoices(deepseek, 'medium').effective).toBe('high')
    expect(getThinkingLevelChoices(deepseek, 'xhigh').effective).toBe('max')
    expect(getThinkingLevelChoices(deepseek, 'minimal').effective).toBe('low')
  })

  it('only offers off for non-reasoning models', () => {
    expect(getThinkingLevelChoices({ ...deepseek, reasoning: false }, 'high')).toEqual({ levels: ['off'], effective: 'off' })
  })

  it('opts xhigh/max in only when mapped', () => {
    expect(getThinkingLevelChoices({ ...deepseek, thinkingLevelMap: undefined }, 'max'))
      .toEqual({ levels: ['off', 'minimal', 'low', 'medium', 'high'], effective: 'high' })
  })

  it('falls back to every level when the model is unknown', () => {
    expect(getThinkingLevelChoices(undefined, 'xhigh').levels).toHaveLength(7)
  })
})

describe('findModelSpecByComposite', () => {
  it('resolves composites and bare provider ids', () => {
    expect(findModelSpecByComposite(providers, 'custom-gateway:ds')).toBe(deepseek)
    expect(findModelSpecByComposite(providers, 'custom-gateway')).toBe(deepseek)
    expect(findModelSpecByComposite(providers, 'custom-gateway:plain')).toBeUndefined()
    expect(findModelSpecByComposite(providers, '')).toBeUndefined()
  })
})

describe('buildThinkingLevelSelectOptions', () => {
  const label = (level: string) => level.toUpperCase()
  const unsupported = (level: string, effective: string) => `${level}->${effective}`

  it('offers the supported levels', () => {
    expect(buildThinkingLevelSelectOptions(deepseek, 'high', label, unsupported).map(o => o.label))
      .toEqual(['OFF', 'LOW', 'HIGH', 'MAX'])
  })

  it('keeps an unsupported current value, labelled with the level it runs as', () => {
    expect(buildThinkingLevelSelectOptions(deepseek, 'medium', label, unsupported).map(o => o.label))
      .toEqual(['OFF', 'LOW', 'medium->high', 'HIGH', 'MAX'])
  })

  it('treats an empty value as "default" without adding an option', () => {
    expect(buildThinkingLevelSelectOptions(deepseek, '', label, unsupported)).toHaveLength(4)
  })
})
