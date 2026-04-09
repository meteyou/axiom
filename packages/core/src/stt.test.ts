import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock config module before importing stt
vi.mock('./config.js', () => ({
  loadConfig: vi.fn(),
  ensureConfigTemplates: vi.fn(),
}))

import { loadSttSettings, transcribeAudio, transcribeWhisperUrl } from './stt.js'
import { loadConfig } from './config.js'

const mockLoadConfig = vi.mocked(loadConfig)

// ── loadSttSettings ──────────────────────────────────────────────────

describe('loadSttSettings', () => {
  it('returns defaults when stt section is missing', () => {
    mockLoadConfig.mockReturnValue({})
    const result = loadSttSettings()
    expect(result).toEqual({
      enabled: false,
      provider: 'whisper-url',
      whisperUrl: '',
      providerId: '',
      ollamaModel: '',
      rewrite: {
        enabled: false,
        providerId: '',
      },
    })
  })

  it('returns defaults when stt is empty object', () => {
    mockLoadConfig.mockReturnValue({ stt: {} })
    const result = loadSttSettings()
    expect(result.enabled).toBe(false)
    expect(result.provider).toBe('whisper-url')
    expect(result.whisperUrl).toBe('')
    expect(result.rewrite.enabled).toBe(false)
  })

  it('returns configured values', () => {
    mockLoadConfig.mockReturnValue({
      stt: {
        enabled: true,
        provider: 'whisper-url',
        whisperUrl: 'http://localhost:8000/v1/audio/transcriptions',
        providerId: 'prov-1',
        ollamaModel: 'whisper-large',
        rewrite: {
          enabled: true,
          providerId: 'prov-2',
        },
      },
    })
    const result = loadSttSettings()
    expect(result.enabled).toBe(true)
    expect(result.provider).toBe('whisper-url')
    expect(result.whisperUrl).toBe('http://localhost:8000/v1/audio/transcriptions')
    expect(result.providerId).toBe('prov-1')
    expect(result.ollamaModel).toBe('whisper-large')
    expect(result.rewrite.enabled).toBe(true)
    expect(result.rewrite.providerId).toBe('prov-2')
  })

  it('handles missing rewrite section gracefully', () => {
    mockLoadConfig.mockReturnValue({
      stt: {
        enabled: true,
        provider: 'openai',
      },
    })
    const result = loadSttSettings()
    expect(result.rewrite).toEqual({ enabled: false, providerId: '' })
  })
})

// ── transcribeWhisperUrl ─────────────────────────────────────────────

describe('transcribeWhisperUrl', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('sends correct request to the URL', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('Hello world'),
    })
    globalThis.fetch = mockFetch

    const buffer = Buffer.from('fake-audio-data')
    const result = await transcribeWhisperUrl(buffer, 'http://localhost:8000/v1/audio/transcriptions')

    expect(result).toBe('Hello world')
    expect(mockFetch).toHaveBeenCalledTimes(1)

    const [url, options] = mockFetch.mock.calls[0]
    expect(url).toBe('http://localhost:8000/v1/audio/transcriptions')
    expect(options.method).toBe('POST')
    expect(options.body).toBeInstanceOf(FormData)

    // Verify form data contains the required fields
    const formData = options.body as FormData
    expect(formData.get('response_format')).toBe('text')
    expect(formData.get('file')).toBeInstanceOf(Blob)
  })

  it('includes language parameter when provided', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('Hallo Welt'),
    })
    globalThis.fetch = mockFetch

    const buffer = Buffer.from('fake-audio-data')
    await transcribeWhisperUrl(buffer, 'http://localhost:8000/v1/audio/transcriptions', 'German')

    const formData = mockFetch.mock.calls[0][1].body as FormData
    expect(formData.get('language')).toBe('German')
  })

  it('does not include language when not provided', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('Hello'),
    })
    globalThis.fetch = mockFetch

    const buffer = Buffer.from('fake-audio-data')
    await transcribeWhisperUrl(buffer, 'http://localhost:8000/v1/audio/transcriptions')

    const formData = mockFetch.mock.calls[0][1].body as FormData
    expect(formData.get('language')).toBeNull()
  })

  it('trims whitespace from response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('  Hello world  \n'),
    })
    globalThis.fetch = mockFetch

    const buffer = Buffer.from('fake-audio-data')
    const result = await transcribeWhisperUrl(buffer, 'http://localhost:8000/v1/audio/transcriptions')
    expect(result).toBe('Hello world')
  })

  it('throws on non-200 response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Internal Server Error'),
    })
    globalThis.fetch = mockFetch

    const buffer = Buffer.from('fake-audio-data')
    await expect(
      transcribeWhisperUrl(buffer, 'http://localhost:8000/v1/audio/transcriptions'),
    ).rejects.toThrow('Whisper URL returned HTTP 500: Internal Server Error')
  })

  it('throws on network error', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    globalThis.fetch = mockFetch

    const buffer = Buffer.from('fake-audio-data')
    await expect(
      transcribeWhisperUrl(buffer, 'http://localhost:8000/v1/audio/transcriptions'),
    ).rejects.toThrow('Whisper URL request failed: ECONNREFUSED')
  })
})

// ── transcribeAudio (dispatcher) ─────────────────────────────────────

describe('transcribeAudio', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('throws when STT is not enabled', async () => {
    mockLoadConfig.mockReturnValue({ stt: { enabled: false } })

    await expect(transcribeAudio(Buffer.from('audio'))).rejects.toThrow(
      'STT is not enabled',
    )
  })

  it('routes to whisper-url provider', async () => {
    mockLoadConfig.mockReturnValue({
      stt: {
        enabled: true,
        provider: 'whisper-url',
        whisperUrl: 'http://localhost:8000/v1/audio/transcriptions',
      },
    })

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('transcribed text'),
    })
    globalThis.fetch = mockFetch

    const result = await transcribeAudio(Buffer.from('audio'), { language: 'English' })
    expect(result).toBe('transcribed text')
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('throws when whisper-url is selected but not configured', async () => {
    mockLoadConfig.mockReturnValue({
      stt: {
        enabled: true,
        provider: 'whisper-url',
        whisperUrl: '',
      },
    })

    await expect(transcribeAudio(Buffer.from('audio'))).rejects.toThrow(
      'Whisper URL is not configured',
    )
  })

  it('throws for openai provider (not yet implemented)', async () => {
    mockLoadConfig.mockReturnValue({
      stt: {
        enabled: true,
        provider: 'openai',
      },
    })

    await expect(transcribeAudio(Buffer.from('audio'))).rejects.toThrow(
      'OpenAI STT provider is not yet implemented',
    )
  })

  it('throws for ollama provider (not yet implemented)', async () => {
    mockLoadConfig.mockReturnValue({
      stt: {
        enabled: true,
        provider: 'ollama',
      },
    })

    await expect(transcribeAudio(Buffer.from('audio'))).rejects.toThrow(
      'Ollama STT provider is not yet implemented',
    )
  })

  it('throws for unknown provider', async () => {
    mockLoadConfig.mockReturnValue({
      stt: {
        enabled: true,
        provider: 'unknown-provider',
      },
    })

    await expect(transcribeAudio(Buffer.from('audio'))).rejects.toThrow(
      'Unknown STT provider: unknown-provider',
    )
  })
})
