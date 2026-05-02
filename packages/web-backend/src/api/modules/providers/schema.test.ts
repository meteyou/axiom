import { describe, expect, it } from 'vitest'
import { PROVIDER_TYPE_PRESETS } from '@axiom/core'
import {
  parseFallbackPayload,
  parseOAuthCodePayload,
  parseOAuthLoginPayload,
  parseOllamaProbePayload,
  parseProviderCreatePayload,
  parseProviderTypeParam,
  parseProviderUpdatePayload,
  validateOllamaUrl,
} from './schema.js'

describe('providers schema', () => {
  it('validates provider type params', () => {
    expect(parseProviderTypeParam('openai')).toEqual({ ok: true, value: 'openai' })

    const invalid = parseProviderTypeParam('not-a-provider')
    expect(invalid.ok).toBe(false)
    if (!invalid.ok) {
      expect(invalid.error).toContain('Invalid provider type. Must be one of:')
    }
  })

  it('parses fallback payload semantics', () => {
    expect(parseFallbackPayload({ providerId: null })).toEqual({
      ok: true,
      value: { providerId: null, modelId: null },
    })

    expect(parseFallbackPayload({ providerId: 'provider-1', modelId: 'model-a' })).toEqual({
      ok: true,
      value: { providerId: 'provider-1', modelId: 'model-a' },
    })

    expect(parseFallbackPayload({ providerId: '   ' })).toEqual({
      ok: false,
      error: 'providerId must be a non-empty string or null',
    })
  })

  it('keeps create/update validation outcomes stable', () => {
    expect(parseProviderCreatePayload({}, PROVIDER_TYPE_PRESETS as unknown as typeof PROVIDER_TYPE_PRESETS)).toEqual({
      ok: false,
      error: 'Provider name is required',
    })

    expect(parseProviderUpdatePayload({ providerType: 'invalid-provider' })).toEqual({
      ok: false,
      error: expect.stringContaining('Invalid provider type. Must be one of:'),
    })
  })

  it('parses oauth payloads and validates required code', () => {
    expect(parseOAuthLoginPayload({ providerType: 'openai', name: 'OpenAI', defaultModel: 'gpt-4o-mini' })).toEqual({
      ok: true,
      value: {
        providerType: 'openai',
        name: 'OpenAI',
        defaultModel: 'gpt-4o-mini',
        providerId: undefined,
        textVerbosity: undefined,
        transport: undefined,
      },
    })

    expect(parseOAuthCodePayload({})).toEqual({ ok: false, error: 'Code is required' })
  })

  it('parses transport field on create payload (sse / websocket / websocket-cached / auto / null)', () => {
    const presets = PROVIDER_TYPE_PRESETS as unknown as typeof PROVIDER_TYPE_PRESETS
    const base = { name: 'codex', providerType: 'openai-codex', defaultModel: 'gpt-5-codex' }

    for (const value of ['sse', 'websocket', 'websocket-cached', 'auto'] as const) {
      const result = parseProviderCreatePayload({ ...base, transport: value }, presets)
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.value.transport).toBe(value)
    }

    // null / empty string → explicit clear
    const cleared = parseProviderCreatePayload({ ...base, transport: null }, presets)
    expect(cleared.ok).toBe(true)
    if (cleared.ok) expect(cleared.value.transport).toBeNull()

    // unknown values are dropped (undefined), not echoed back unchecked
    const garbage = parseProviderCreatePayload({ ...base, transport: 'http2' }, presets)
    expect(garbage.ok).toBe(true)
    if (garbage.ok) expect(garbage.value.transport).toBeUndefined()
  })

  it('parses transport field on update payload', () => {
    const updated = parseProviderUpdatePayload({ transport: 'websocket-cached' })
    expect(updated.ok).toBe(true)
    if (updated.ok) expect(updated.value.transport).toBe('websocket-cached')

    const cleared = parseProviderUpdatePayload({ transport: null })
    expect(cleared.ok).toBe(true)
    if (cleared.ok) expect(cleared.value.transport).toBeNull()
  })

  it('validates ollama probe payload and url format', () => {
    expect(parseOllamaProbePayload({ providerType: 'ollama' })).toEqual({
      ok: true,
      value: {
        providerType: 'ollama',
        baseUrl: 'http://localhost:11434',
      },
    })

    expect(parseOllamaProbePayload({ providerType: 'openai' })).toEqual({
      ok: false,
      error: 'providerType must be ollama',
    })

    expect(() => validateOllamaUrl('ftp://localhost')).toThrowError('Only http/https URLs are allowed')
    expect(() => validateOllamaUrl('http://localhost:11434')).not.toThrow()
  })
})
