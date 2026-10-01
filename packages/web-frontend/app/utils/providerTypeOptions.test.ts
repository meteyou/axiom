import { describe, expect, it } from 'vitest'
import { buildProviderTypeOptions, providerTypeLabel } from './providerTypeOptions'

const t = (key: string) => ({
  'providers.providerTypes.custom-anthropic-messages': 'Benutzerdefiniert – Anthropic Messages',
}[key] ?? key)

describe('provider type options', () => {
  it('uses translations when available and falls back to the backend label', () => {
    expect(providerTypeLabel('custom-anthropic-messages', { label: 'Custom – Anthropic Messages' }, t))
      .toBe('Benutzerdefiniert – Anthropic Messages')
    expect(providerTypeLabel('openai', { label: 'OpenAI' }, t)).toBe('OpenAI')
    expect(providerTypeLabel('unknown', undefined, t)).toBe('unknown')
  })

  it('sorts options by label', () => {
    expect(buildProviderTypeOptions([
      ['openai', { label: 'OpenAI' }],
      ['custom-anthropic-messages', { label: 'Custom – Anthropic Messages' }],
    ], t)).toEqual([
      { value: 'custom-anthropic-messages', label: 'Benutzerdefiniert – Anthropic Messages' },
      { value: 'openai', label: 'OpenAI' },
    ])
  })
})
