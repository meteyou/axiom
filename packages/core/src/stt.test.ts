import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./config.js', () => ({
  loadConfig: vi.fn(),
  ensureConfigTemplates: vi.fn(),
}))

vi.mock('./provider-config.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>
  return {
    ...original,
    loadProvidersDecrypted: vi.fn(),
    getApiKeyForProvider: vi.fn(),
    buildModel: vi.fn().mockReturnValue({ id: 'mock-model' }),
  }
})

vi.mock('./pi-models.js', () => ({
  completeSimple: vi.fn(),
  streamSimple: vi.fn(),
}))

import { loadSttSettings, transcribeAudio, rewriteTranscript } from './stt.js'
import { loadConfig } from './config.js'
import { loadProvidersDecrypted, getApiKeyForProvider, buildModel } from './provider-config.js'
import type { ProviderConfig } from './provider-config.js'
import { completeSimple } from './pi-models.js'

const mockLoadConfig = vi.mocked(loadConfig)
const mockLoadProvidersDecrypted = vi.mocked(loadProvidersDecrypted)
const mockGetApiKeyForProvider = vi.mocked(getApiKeyForProvider)
const mockBuildModel = vi.mocked(buildModel)
const mockCompleteSimple = vi.mocked(completeSimple)

const originalFetch = globalThis.fetch

function voiceProvider(id: string, providerType: string, baseUrl: string, extra: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id,
    name: id.toUpperCase(),
    type: 'openai-completions',
    providerType: providerType as ProviderConfig['providerType'],
    provider: providerType,
    baseUrl,
    apiKey: 'key',
    enabledModels: [],
    ...extra,
  }
}

const openai = voiceProvider('oai', 'openai', 'https://api.openai.com/v1', { enabledModels: ['gpt-4o'], enabledSttModels: ['whisper-1'] })
const openrouter = voiceProvider('or', 'openrouter', 'https://openrouter.ai/api/v1', { enabledSttModels: ['openai/whisper-1'] })
const xai = voiceProvider('x', 'xai', 'https://api.x.ai/v1', { enabledSttModels: ['grok-voice-transcribe-2.0'] })
const deepgram = voiceProvider('dg', 'deepgram', 'https://api.deepgram.com', {
  type: 'deepgram',
  enabledSttModels: ['nova-3', 'nova-2'],
  disabledSttModels: ['nova-2'],
})

function mockStt(stt: Record<string, unknown>) {
  mockLoadConfig.mockReturnValue({ stt })
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockLoadProvidersDecrypted.mockReturnValue({ providers: [openai, openrouter, xai, deepgram] } as ReturnType<typeof loadProvidersDecrypted>)
  mockGetApiKeyForProvider.mockResolvedValue('sk-test')
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('loadSttSettings', () => {
  it('returns defaults when the stt section is missing', () => {
    mockLoadConfig.mockReturnValue({})
    expect(loadSttSettings()).toEqual({ enabled: false, model: '', language: '', rewrite: { enabled: false, providerId: '' } })
  })

  it('ignores pre-provider keys and reads the model reference', () => {
    mockStt({ enabled: true, provider: 'whisper-url', whisperUrl: 'http://w', model: 'dg:nova-3', language: 'de' })
    expect(loadSttSettings()).toEqual({ enabled: true, model: 'dg:nova-3', language: 'de', rewrite: { enabled: false, providerId: '' } })
  })
})

describe('transcribeAudio', () => {
  it('throws when STT is not enabled', async () => {
    mockStt({ enabled: false, model: 'oai:whisper-1' })
    await expect(transcribeAudio(Buffer.from('audio'))).rejects.toThrow('STT is not enabled')
  })

  it('asks for a model when none is selected', async () => {
    mockStt({ enabled: true, model: '' })
    await expect(transcribeAudio(Buffer.from('audio'))).rejects.toThrow('No STT model selected')
  })

  it('rejects disabled or unknown voice models', async () => {
    mockStt({ enabled: true, model: 'dg:nova-2' })
    await expect(transcribeAudio(Buffer.from('audio'))).rejects.toThrow('STT model "nova-2" is not enabled')
    mockStt({ enabled: true, model: 'gone:whisper-1' })
    await expect(transcribeAudio(Buffer.from('audio'))).rejects.toThrow('STT provider not found: gone')
  })

  it('posts multipart audio to OpenAI and maps the chat language to an ISO code', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ text: ' Hello world ' }))
    globalThis.fetch = fetchMock
    mockStt({ enabled: true, model: 'oai:whisper-1' })

    const result = await transcribeAudio(Buffer.from('audio'), { language: 'German', filename: 'voice.ogg' })

    expect(result).toEqual({ transcript: 'Hello world' })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test')
    const form = init.body as FormData
    expect(form.get('model')).toBe('whisper-1')
    expect(form.get('language')).toBe('de')
    expect((form.get('file') as File).name).toBe('voice.ogg')
  })

  it('sends base64 JSON audio to OpenRouter and lets the STT language override win', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ text: 'Bonjour' }))
    globalThis.fetch = fetchMock
    mockStt({ enabled: true, model: 'or:openai/whisper-1', language: 'fr' })

    await transcribeAudio(Buffer.from('audio'), { language: 'en', filename: 'clip.webm' })

    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://openrouter.ai/api/v1/audio/transcriptions')
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'openai/whisper-1',
      input_audio: { data: Buffer.from('audio').toString('base64'), format: 'webm' },
      language: 'fr',
    })
  })

  it('uses the xAI /stt endpoint with the file as the last form field', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ text: 'hi' }))
    globalThis.fetch = fetchMock
    mockStt({ enabled: true, model: 'x:grok-voice-transcribe-2.0' })

    await transcribeAudio(Buffer.from('audio'), { language: 'en' })

    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.x.ai/v1/stt')
    expect([...(init.body as FormData).keys()]).toEqual(['model', 'language', 'file'])
  })

  it('sends raw audio to Deepgram with the provider key and a matching content type', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ results: { channels: [{ alternatives: [{ transcript: 'Hallo' }] }] } }))
    globalThis.fetch = fetchMock
    mockStt({ enabled: true, model: 'dg:nova-3', language: 'multi' })

    const result = await transcribeAudio(Buffer.from('audio'), { filename: 'audio.ogg' })

    expect(result.transcript).toBe('Hallo')
    const [url, init] = fetchMock.mock.calls[0]!
    const parsed = new URL(url as string)
    expect(parsed.origin + parsed.pathname).toBe('https://api.deepgram.com/v1/listen')
    expect(parsed.searchParams.get('model')).toBe('nova-3')
    expect(parsed.searchParams.get('language')).toBe('multi')
    expect((init.headers as Record<string, string>).Authorization).toBe('Token sk-test')
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('audio/ogg')
  })

  it('surfaces provider errors with the HTTP status', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('quota exceeded', { status: 429 }))
    mockStt({ enabled: true, model: 'oai:whisper-1' })
    await expect(transcribeAudio(Buffer.from('audio'))).rejects.toThrow('OpenAI STT returned HTTP 429. quota exceeded')
  })

  describe('rewrite', () => {
    beforeEach(() => {
      globalThis.fetch = vi.fn().mockImplementation(async () => jsonResponse({ text: 'um like raw transcript' }))
      mockBuildModel.mockReturnValue({ id: 'gpt-4o' } as ReturnType<typeof buildModel>)
    })

    it('returns both fields when rewrite is enabled', async () => {
      mockStt({ enabled: true, model: 'oai:whisper-1', rewrite: { enabled: true, providerId: 'oai:gpt-4o' } })
      mockCompleteSimple.mockResolvedValue({
        content: [{ type: 'text', text: 'cleaned transcript' }],
      } as unknown as Awaited<ReturnType<typeof completeSimple>>)

      const result = await transcribeAudio(Buffer.from('audio'))
      expect(result).toEqual({ transcript: 'um like raw transcript', rewritten: 'cleaned transcript' })
    })

    it('skips the rewrite when it is disabled or has no provider', async () => {
      mockStt({ enabled: true, model: 'oai:whisper-1', rewrite: { enabled: true, providerId: '' } })
      expect(await transcribeAudio(Buffer.from('audio'))).toEqual({ transcript: 'um like raw transcript' })
      mockStt({ enabled: true, model: 'oai:whisper-1', rewrite: { enabled: false, providerId: 'oai:gpt-4o' } })
      expect(await transcribeAudio(Buffer.from('audio'))).toEqual({ transcript: 'um like raw transcript' })
      expect(mockCompleteSimple).not.toHaveBeenCalled()
    })

    it('returns the raw transcript when the rewrite fails', async () => {
      mockStt({ enabled: true, model: 'oai:whisper-1', rewrite: { enabled: true, providerId: 'oai:gpt-4o' } })
      mockCompleteSimple.mockRejectedValue(new Error('Internal Server Error'))
      expect(await transcribeAudio(Buffer.from('audio'))).toEqual({ transcript: 'um like raw transcript' })
    })
  })
})

describe('rewriteTranscript', () => {
  it('calls completeSimple with the editor prompt and returns trimmed text', async () => {
    mockCompleteSimple.mockResolvedValue({
      content: [{ type: 'text', text: '  Cleaned text.  \n' }],
    } as unknown as Awaited<ReturnType<typeof completeSimple>>)

    expect(await rewriteTranscript('um so like hello world', 'oai')).toBe('Cleaned text.')
    const [, context] = mockCompleteSimple.mock.calls[0]!
    expect(context.systemPrompt).toContain('filler words')
    expect(context.messages[0]!.content).toBe('um so like hello world')
  })

  it('throws when the provider is missing or the response is empty', async () => {
    await expect(rewriteTranscript('text', 'nonexistent')).rejects.toThrow('Rewrite provider not found: nonexistent')
    mockCompleteSimple.mockResolvedValue({ content: [] } as unknown as Awaited<ReturnType<typeof completeSimple>>)
    await expect(rewriteTranscript('text', 'oai')).rejects.toThrow('Rewrite returned no content.')
  })

  it('refuses disabled providers and models', async () => {
    mockLoadProvidersDecrypted.mockReturnValue({
      providers: [
        { ...openai, disabledModels: ['gpt-4o'] },
        voiceProvider('off', 'openai', 'https://api.openai.com/v1', { enabledModels: ['gpt-4o'], disabled: true }),
      ],
    } as ReturnType<typeof loadProvidersDecrypted>)
    await expect(rewriteTranscript('text', 'oai:gpt-4o')).rejects.toThrow('Rewrite model is disabled: oai:gpt-4o')
    await expect(rewriteTranscript('text', 'off:gpt-4o')).rejects.toThrow('Rewrite model is disabled: off:gpt-4o')
    expect(mockCompleteSimple).not.toHaveBeenCalled()
  })
})
