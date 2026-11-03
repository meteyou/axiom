import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./config.js', () => ({
  ensureConfigTemplates: vi.fn(),
  loadConfig: vi.fn(),
}))

vi.mock('./token-logger.js', () => ({
  logTokenUsage: vi.fn(),
}))

// Mock Deepgram so we can assert chunk count and avoid real HTTP.
vi.mock('./deepgram.js', async () => {
  const actual = await vi.importActual<typeof import('./deepgram.js')>('./deepgram.js')
  return {
    ...actual,
    synthesizeDeepgram: vi.fn(async (text: string) => Buffer.from(`audio:${text.length}`)),
  }
})

const PROVIDERS = [
  {
    id: 'dg',
    name: 'Deepgram',
    type: 'deepgram',
    providerType: 'deepgram',
    provider: 'deepgram',
    baseUrl: 'https://api.deepgram.com',
    apiKey: 'dg_test',
    enabledModels: [],
    enabledTtsModels: ['aura-2-thalia-en'],
  },
  {
    id: 'oai',
    name: 'OpenAI',
    type: 'openai-completions',
    providerType: 'openai',
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk',
    enabledModels: ['gpt-4o'],
    enabledTtsModels: ['gpt-4o-mini-tts', 'tts-1'],
    models: [{ id: 'tts-1', cost: { input: 15 } }],
  },
  {
    id: 'or',
    name: 'OpenRouter',
    type: 'openai-completions',
    providerType: 'openrouter',
    provider: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: 'sk-or',
    enabledModels: [],
    enabledTtsModels: ['deepgram/aura-2'],
  },
]

vi.mock('./provider-config.js', async () => {
  const actual = await vi.importActual<typeof import('./provider-config.js')>('./provider-config.js')
  return {
    ...actual,
    loadProvidersDecrypted: vi.fn(() => ({ providers: PROVIDERS })),
    getApiKeyForProvider: vi.fn(async (provider: { apiKey: string }) => provider.apiKey),
  }
})

import { loadConfig } from './config.js'
import { synthesizeDeepgram } from './deepgram.js'
import { synthesizeTts } from './tts.js'
import { logTokenUsage } from './token-logger.js'
import type { Database } from './database.js'
import { clearVoiceModelListCache, getVoiceBackend } from './voice-backends.js'
import type { TtsResponseFormat } from './contracts/settings.js'

const loadConfigMock = vi.mocked(loadConfig)
const synthesizeDeepgramMock = vi.mocked(synthesizeDeepgram)
const originalFetch = globalThis.fetch

function mockTts(tts: Record<string, unknown>) {
  loadConfigMock.mockImplementation(() => ({ tts }) as never)
}

function mockSettings(responseFormat: TtsResponseFormat) {
  mockTts({ enabled: true, model: 'dg:aura-2-thalia-en', responseFormat })
}

afterEach(() => {
  globalThis.fetch = originalFetch
  clearVoiceModelListCache()
})

beforeEach(() => {
  vi.clearAllMocks()
  synthesizeDeepgramMock.mockImplementation(async (text: string) => Buffer.from(`audio:${text.length}`))
})

describe('synthesizeTts (Deepgram chunking)', () => {
  it('sends 2000-char opus input in a single Deepgram call (no concat-unsafe chunking)', async () => {
    mockSettings('opus')
    const text = 'a'.repeat(2000)
    await expect(synthesizeTts(text)).resolves.toMatchObject({ extension: 'ogg' })
    // opus pages don't survive naive Buffer.concat(), so even though the
    // internal chunker (1900-char limit) would split this, we must call
    // Deepgram exactly once for inputs ≤2000 chars.
    expect(synthesizeDeepgramMock).toHaveBeenCalledTimes(1)
  })

  it('sends 1901-char flac input in a single Deepgram call (boundary just past chunk limit)', async () => {
    mockSettings('flac')
    const text = 'a'.repeat(1901)
    await expect(synthesizeTts(text)).resolves.toMatchObject({ extension: 'flac' })
    expect(synthesizeDeepgramMock).toHaveBeenCalledTimes(1)
  })

  it('never chunks opus/flac at or below the Deepgram hard limit (regression)', async () => {
    // Same multi-sentence text that *does* split for mp3/wav. Proves
    // opus/flac follow the single-call path purely on encoding, not
    // length.
    const sentence = `${'word '.repeat(76).trim()}. `
    const text = sentence.repeat(5) // > 1900 chunk limit but ≤ 2000
    expect(text.length).toBeGreaterThan(1900)
    expect(text.length).toBeLessThanOrEqual(2000)

    mockSettings('opus')
    await synthesizeTts(text)
    expect(synthesizeDeepgramMock).toHaveBeenCalledTimes(1)

    synthesizeDeepgramMock.mockClear()
    mockSettings('flac')
    await synthesizeTts(text)
    expect(synthesizeDeepgramMock).toHaveBeenCalledTimes(1)
  })

  it('falls back to MP3 for opus/flac input strictly longer than 2000 chars', async () => {
    mockSettings('opus')
    await expect(synthesizeTts('a'.repeat(2001))).resolves.toMatchObject({ extension: 'mp3' })
    expect(synthesizeDeepgramMock.mock.calls.every(call => call[2]?.encoding === 'mp3')).toBe(true)

    synthesizeDeepgramMock.mockClear()
    mockSettings('flac')
    await expect(synthesizeTts('a'.repeat(5000))).resolves.toMatchObject({ extension: 'mp3' })
    expect(synthesizeDeepgramMock.mock.calls.every(call => call[2]?.encoding === 'mp3')).toBe(true)
  })

  it('backend still rejects opus input strictly longer than 2000 chars', async () => {
    const backend = getVoiceBackend('deepgram')
    await expect(backend.synthesize({ baseUrl: '', apiKey: 'key' }, { text: 'a'.repeat(2001), modelId: 'aura-2-thalia-en', format: 'opus' }))
      .rejects.toThrow(/2001 chars \(>2000\).*MP3 or WAV response format/)
    expect(synthesizeDeepgramMock).not.toHaveBeenCalled()
  })

  it('chunks long mp3 input across multiple Deepgram calls and concatenates the audio', async () => {
    mockSettings('mp3')
    // Build a multi-sentence text well above 2000 chars so the chunker
    // splits on sentence boundaries rather than the hard slice path.
    const sentence = `${'word '.repeat(80).trim()}. `
    const text = sentence.repeat(8) // ~3300 chars
    const result = await synthesizeTts(text)
    expect(synthesizeDeepgramMock.mock.calls.length).toBeGreaterThan(1)
    expect(result.extension).toBe('mp3')
    // Each call returns Buffer.from(`audio:${chunk.length}`); the result
    // is the concatenation of all chunks' audio.
    const expectedLen = synthesizeDeepgramMock.mock.calls
      .map(([chunk]) => Buffer.byteLength(`audio:${(chunk as string).length}`))
      .reduce((a, b) => a + b, 0)
    expect(result.audio.length).toBe(expectedLen)
  })

  it('chunks long wav input and wraps the concatenated PCM in a WAV header', async () => {
    mockSettings('wav')
    const sentence = `${'word '.repeat(80).trim()}. `
    const text = sentence.repeat(8)
    const result = await synthesizeTts(text)
    expect(synthesizeDeepgramMock.mock.calls.length).toBeGreaterThan(1)
    expect(result.contentType).toBe('audio/wav')
    expect(result.extension).toBe('wav')
    // RIFF/WAVE magic — proves we wrapped the concatenated PCM rather
    // than handing back raw bytes.
    expect(result.audio.slice(0, 4).toString()).toBe('RIFF')
    expect(result.audio.slice(8, 12).toString()).toBe('WAVE')
  })

  it('passes short opus input through unchanged (single Deepgram call, no rejection)', async () => {
    mockSettings('opus')
    const text = 'short hello'
    await expect(synthesizeTts(text)).resolves.toMatchObject({ contentType: 'audio/ogg' })
    expect(synthesizeDeepgramMock).toHaveBeenCalledTimes(1)
  })
})

describe('synthesizeTts (settings and providers)', () => {
  it('refuses while disabled unless the preview asks to ignore it', async () => {
    mockTts({ enabled: false, model: 'dg:aura-2-thalia-en' })
    await expect(synthesizeTts('hi')).rejects.toThrow('TTS is not enabled')
    await expect(synthesizeTts('hi', { ignoreEnabled: true })).resolves.toMatchObject({ extension: 'mp3' })
  })

  it('asks for a model when none is selected', async () => {
    mockTts({ enabled: true, model: '' })
    await expect(synthesizeTts('hi')).rejects.toThrow('No TTS model selected')
  })

  it('sends voice, format and instructions to OpenAI gpt-4o TTS models only', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(new Uint8Array([1, 2, 3])))
    globalThis.fetch = fetchMock
    mockTts({ enabled: true, model: 'oai:gpt-4o-mini-tts', voice: 'coral', instructions: 'Be calm', responseFormat: 'opus' })

    const result = await synthesizeTts('Hello')
    expect(result).toMatchObject({ contentType: 'audio/ogg', extension: 'ogg' })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.openai.com/v1/audio/speech')
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'gpt-4o-mini-tts',
      input: 'Hello',
      response_format: 'opus',
      voice: 'coral',
      instructions: 'Be calm',
    })

    await synthesizeTts('Hello', { settings: { model: 'oai:tts-1', voice: '' } })
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body as string)).toEqual({
      model: 'tts-1',
      input: 'Hello',
      response_format: 'opus',
      voice: 'alloy',
    })
  })

  it('falls back to MP3 and the first supported voice on OpenRouter', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => (url.includes('/models')
      ? new Response(JSON.stringify({ data: [{ id: 'deepgram/aura-2', supported_voices: ['aura-2-thalia-en', 'aura-2-zeus-en'] }] }))
      : new Response(new Uint8Array([1]))))
    globalThis.fetch = fetchMock
    mockTts({ enabled: true, model: 'or:deepgram/aura-2', responseFormat: 'wav' })

    const result = await synthesizeTts('Hi')
    expect(result).toMatchObject({ contentType: 'audio/mpeg', extension: 'mp3' })
    const speech = fetchMock.mock.calls.find(([url]) => (url as string).endsWith('/audio/speech'))!
    expect(JSON.parse(speech[1].body as string)).toEqual({
      model: 'deepgram/aura-2',
      input: 'Hi',
      response_format: 'mp3',
      voice: 'aura-2-thalia-en',
    })
  })
})

describe('synthesizeTts usage booking', () => {
  it('books the spoken characters priced per 1M characters', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async () => new Response(new Uint8Array([1])))
    mockTts({ enabled: true, model: 'oai:tts-1', responseFormat: 'mp3' })
    const db = {} as Database

    await synthesizeTts('  Hello world  ', { usage: { db, userId: 3 } })

    expect(vi.mocked(logTokenUsage)).toHaveBeenCalledWith(db, expect.objectContaining({
      provider: 'openai',
      model: 'tts-1',
      kind: 'tts',
      units: 11,
      estimatedCost: (11 * 15) / 1_000_000,
      userId: 3,
    }))
  })

  it('books nothing without a usage context or when synthesis fails', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async () => new Response('nope', { status: 500 }))
    mockTts({ enabled: true, model: 'oai:tts-1' })
    await expect(synthesizeTts('Hi', { usage: { db: {} as Database } })).rejects.toThrow('HTTP 500')
    expect(vi.mocked(logTokenUsage)).not.toHaveBeenCalled()
  })
})
