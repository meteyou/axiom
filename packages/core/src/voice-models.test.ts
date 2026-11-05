import { describe, expect, it, vi } from 'vitest'
import type { ProviderConfig } from './provider-config.js'
import { checkVoiceModelAvailability } from './voice-models.js'

const xai: ProviderConfig = {
  id: 'x',
  name: 'xAI',
  type: 'openai-completions',
  providerType: 'xai',
  provider: 'xai',
  baseUrl: 'https://api.x.ai/v1',
  apiKey: 'invalid-key',
  enabledModels: [],
}

function fetchReturning(status: number, body: unknown = {}) {
  return vi.fn().mockImplementation(async () => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  }))
}

describe('checkVoiceModelAvailability', () => {
  it.each(['tts', 'stt'] as const)('reports xAI %s as down when the key is rejected', async (kind) => {
    const fetchImpl = fetchReturning(401, { error: 'invalid key' })
    const modelId = kind === 'tts' ? 'grok-voice-tts-1.0' : 'grok-voice-transcribe-2.0'

    const result = await checkVoiceModelAvailability(xai, kind, modelId, { fetchImpl: fetchImpl as unknown as typeof fetch })

    expect(result.status).toBe('down')
    expect(result.errorMessage).toContain('authentication failed (HTTP 401)')
    expect(fetchImpl).toHaveBeenCalled()
  })

  it('reports xAI as healthy when the key is accepted, using the static model catalog', async () => {
    const tts = fetchReturning(200, { voices: [{ voice_id: 'eve' }] })
    expect(await checkVoiceModelAvailability(xai, 'tts', 'grok-voice-tts-1.0', { fetchImpl: tts as unknown as typeof fetch }))
      .toMatchObject({ status: 'healthy' })
    expect(tts.mock.calls[0]![0]).toBe('https://api.x.ai/v1/tts/voices')

    const stt = fetchReturning(200, { data: [{ id: 'grok-4' }] })
    expect(await checkVoiceModelAvailability(xai, 'stt', 'grok-voice-transcribe-2.0', { fetchImpl: stt as unknown as typeof fetch }))
      .toMatchObject({ status: 'healthy' })
  })
})
