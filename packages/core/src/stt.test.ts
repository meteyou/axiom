import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock config module before importing stt
vi.mock('./config.js', () => ({
  loadConfig: vi.fn(),
  ensureConfigTemplates: vi.fn(),
}))

// Mock provider-config module
vi.mock('./provider-config.js', () => ({
  loadProvidersDecrypted: vi.fn(),
  getApiKeyForProvider: vi.fn(),
}))

import { loadSttSettings, transcribeAudio, transcribeWhisperUrl, transcribeOpenAi, transcribeOllama } from './stt.js'
import { loadConfig } from './config.js'
import { loadProvidersDecrypted, getApiKeyForProvider } from './provider-config.js'

const mockLoadConfig = vi.mocked(loadConfig)
const mockLoadProvidersDecrypted = vi.mocked(loadProvidersDecrypted)
const mockGetApiKeyForProvider = vi.mocked(getApiKeyForProvider)

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

// ── transcribeOpenAi ─────────────────────────────────────────────────

describe('transcribeOpenAi', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('constructs correct URL and sends auth header', async () => {
    mockLoadProvidersDecrypted.mockReturnValue({
      providers: [{ id: 'oai-1', baseUrl: 'https://api.openai.com', providerType: 'openai' }],
    } as ReturnType<typeof loadProvidersDecrypted>)
    mockGetApiKeyForProvider.mockResolvedValue('sk-test-key')

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('Hello world'),
    })
    globalThis.fetch = mockFetch

    const buffer = Buffer.from('fake-audio')
    const result = await transcribeOpenAi(buffer, 'oai-1')

    expect(result).toBe('Hello world')
    expect(mockFetch).toHaveBeenCalledTimes(1)

    const [url, options] = mockFetch.mock.calls[0]
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions')
    expect(options.method).toBe('POST')
    expect(options.headers.Authorization).toBe('Bearer sk-test-key')
  })

  it('sends correct form data fields', async () => {
    mockLoadProvidersDecrypted.mockReturnValue({
      providers: [{ id: 'oai-1', baseUrl: 'https://api.openai.com', providerType: 'openai' }],
    } as ReturnType<typeof loadProvidersDecrypted>)
    mockGetApiKeyForProvider.mockResolvedValue('sk-test-key')

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('transcribed'),
    })
    globalThis.fetch = mockFetch

    const buffer = Buffer.from('audio-data')
    await transcribeOpenAi(buffer, 'oai-1', 'English')

    const formData = mockFetch.mock.calls[0][1].body as FormData
    expect(formData.get('model')).toBe('whisper-1')
    expect(formData.get('response_format')).toBe('text')
    expect(formData.get('language')).toBe('English')
    expect(formData.get('file')).toBeInstanceOf(Blob)
  })

  it('omits language when not provided', async () => {
    mockLoadProvidersDecrypted.mockReturnValue({
      providers: [{ id: 'oai-1', baseUrl: 'https://api.openai.com', providerType: 'openai' }],
    } as ReturnType<typeof loadProvidersDecrypted>)
    mockGetApiKeyForProvider.mockResolvedValue('sk-test-key')

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('Hello'),
    })
    globalThis.fetch = mockFetch

    await transcribeOpenAi(Buffer.from('audio'), 'oai-1')

    const formData = mockFetch.mock.calls[0][1].body as FormData
    expect(formData.get('language')).toBeNull()
  })

  it('strips trailing slash from baseUrl', async () => {
    mockLoadProvidersDecrypted.mockReturnValue({
      providers: [{ id: 'oai-1', baseUrl: 'https://api.openai.com/', providerType: 'openai' }],
    } as ReturnType<typeof loadProvidersDecrypted>)
    mockGetApiKeyForProvider.mockResolvedValue('sk-key')

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('text'),
    })
    globalThis.fetch = mockFetch

    await transcribeOpenAi(Buffer.from('audio'), 'oai-1')

    const [url] = mockFetch.mock.calls[0]
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions')
  })

  it('trims whitespace from response', async () => {
    mockLoadProvidersDecrypted.mockReturnValue({
      providers: [{ id: 'oai-1', baseUrl: 'https://api.openai.com', providerType: 'openai' }],
    } as ReturnType<typeof loadProvidersDecrypted>)
    mockGetApiKeyForProvider.mockResolvedValue('sk-key')

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('  Hello world  \n'),
    })
    globalThis.fetch = mockFetch

    const result = await transcribeOpenAi(Buffer.from('audio'), 'oai-1')
    expect(result).toBe('Hello world')
  })

  it('throws when provider not found', async () => {
    mockLoadProvidersDecrypted.mockReturnValue({
      providers: [],
    } as unknown as ReturnType<typeof loadProvidersDecrypted>)

    await expect(
      transcribeOpenAi(Buffer.from('audio'), 'nonexistent'),
    ).rejects.toThrow('OpenAI STT provider not found: nonexistent')
  })

  it('throws on HTTP error', async () => {
    mockLoadProvidersDecrypted.mockReturnValue({
      providers: [{ id: 'oai-1', baseUrl: 'https://api.openai.com', providerType: 'openai' }],
    } as ReturnType<typeof loadProvidersDecrypted>)
    mockGetApiKeyForProvider.mockResolvedValue('sk-key')

    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('Unauthorized'),
    })
    globalThis.fetch = mockFetch

    await expect(
      transcribeOpenAi(Buffer.from('audio'), 'oai-1'),
    ).rejects.toThrow('OpenAI STT returned HTTP 401: Unauthorized')
  })

  it('throws on network error', async () => {
    mockLoadProvidersDecrypted.mockReturnValue({
      providers: [{ id: 'oai-1', baseUrl: 'https://api.openai.com', providerType: 'openai' }],
    } as ReturnType<typeof loadProvidersDecrypted>)
    mockGetApiKeyForProvider.mockResolvedValue('sk-key')

    const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    globalThis.fetch = mockFetch

    await expect(
      transcribeOpenAi(Buffer.from('audio'), 'oai-1'),
    ).rejects.toThrow('OpenAI STT request failed: ECONNREFUSED')
  })
})

// ── transcribeOllama ─────────────────────────────────────────────────

describe('transcribeOllama', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('strips /v1 from baseUrl and sends to /api/chat', async () => {
    mockLoadProvidersDecrypted.mockReturnValue({
      providers: [{ id: 'oll-1', baseUrl: 'http://localhost:11434/v1', providerType: 'ollama-local' }],
    } as ReturnType<typeof loadProvidersDecrypted>)

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ message: { content: 'Hello world' } }),
    })
    globalThis.fetch = mockFetch

    const buffer = Buffer.from('fake-audio')
    const result = await transcribeOllama(buffer, 'oll-1', 'whisper')

    expect(result).toBe('Hello world')
    expect(mockFetch).toHaveBeenCalledTimes(1)

    const [url] = mockFetch.mock.calls[0]
    expect(url).toBe('http://localhost:11434/api/chat')
  })

  it('works when baseUrl has no /v1 suffix', async () => {
    mockLoadProvidersDecrypted.mockReturnValue({
      providers: [{ id: 'oll-1', baseUrl: 'http://localhost:11434', providerType: 'ollama-local' }],
    } as ReturnType<typeof loadProvidersDecrypted>)

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ message: { content: 'text' } }),
    })
    globalThis.fetch = mockFetch

    await transcribeOllama(Buffer.from('audio'), 'oll-1', 'whisper')

    const [url] = mockFetch.mock.calls[0]
    expect(url).toBe('http://localhost:11434/api/chat')
  })

  it('sends base64 audio in images field with correct JSON body', async () => {
    mockLoadProvidersDecrypted.mockReturnValue({
      providers: [{ id: 'oll-1', baseUrl: 'http://localhost:11434/v1', providerType: 'ollama-local' }],
    } as ReturnType<typeof loadProvidersDecrypted>)

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ message: { content: 'transcribed' } }),
    })
    globalThis.fetch = mockFetch

    const buffer = Buffer.from('fake-audio-data')
    await transcribeOllama(buffer, 'oll-1', 'my-whisper')

    const [, options] = mockFetch.mock.calls[0]
    expect(options.method).toBe('POST')
    expect(options.headers['Content-Type']).toBe('application/json')

    const body = JSON.parse(options.body)
    expect(body.model).toBe('my-whisper')
    expect(body.stream).toBe(false)
    expect(body.messages).toHaveLength(1)
    expect(body.messages[0].role).toBe('user')
    expect(body.messages[0].images).toEqual([buffer.toString('base64')])
  })

  it('uses model name from parameter', async () => {
    mockLoadProvidersDecrypted.mockReturnValue({
      providers: [{ id: 'oll-1', baseUrl: 'http://localhost:11434/v1', providerType: 'ollama-local' }],
    } as ReturnType<typeof loadProvidersDecrypted>)

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ message: { content: 'text' } }),
    })
    globalThis.fetch = mockFetch

    await transcribeOllama(Buffer.from('audio'), 'oll-1', 'whisper-large-v3')

    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.model).toBe('whisper-large-v3')
  })

  it('defaults model to whisper when empty', async () => {
    mockLoadProvidersDecrypted.mockReturnValue({
      providers: [{ id: 'oll-1', baseUrl: 'http://localhost:11434/v1', providerType: 'ollama-local' }],
    } as ReturnType<typeof loadProvidersDecrypted>)

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ message: { content: 'text' } }),
    })
    globalThis.fetch = mockFetch

    await transcribeOllama(Buffer.from('audio'), 'oll-1', '')

    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.model).toBe('whisper')
  })

  it('includes language in prompt when provided', async () => {
    mockLoadProvidersDecrypted.mockReturnValue({
      providers: [{ id: 'oll-1', baseUrl: 'http://localhost:11434/v1', providerType: 'ollama-local' }],
    } as ReturnType<typeof loadProvidersDecrypted>)

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ message: { content: 'Hallo Welt' } }),
    })
    globalThis.fetch = mockFetch

    await transcribeOllama(Buffer.from('audio'), 'oll-1', 'whisper', 'German')

    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.messages[0].content).toContain('German')
  })

  it('trims whitespace from response', async () => {
    mockLoadProvidersDecrypted.mockReturnValue({
      providers: [{ id: 'oll-1', baseUrl: 'http://localhost:11434/v1', providerType: 'ollama-local' }],
    } as ReturnType<typeof loadProvidersDecrypted>)

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ message: { content: '  Hello world  \n' } }),
    })
    globalThis.fetch = mockFetch

    const result = await transcribeOllama(Buffer.from('audio'), 'oll-1', 'whisper')
    expect(result).toBe('Hello world')
  })

  it('throws when provider not found', async () => {
    mockLoadProvidersDecrypted.mockReturnValue({
      providers: [],
    } as unknown as ReturnType<typeof loadProvidersDecrypted>)

    await expect(
      transcribeOllama(Buffer.from('audio'), 'nonexistent', 'whisper'),
    ).rejects.toThrow('Ollama STT provider not found: nonexistent')
  })

  it('throws on HTTP error', async () => {
    mockLoadProvidersDecrypted.mockReturnValue({
      providers: [{ id: 'oll-1', baseUrl: 'http://localhost:11434/v1', providerType: 'ollama-local' }],
    } as ReturnType<typeof loadProvidersDecrypted>)

    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('model not found'),
    })
    globalThis.fetch = mockFetch

    await expect(
      transcribeOllama(Buffer.from('audio'), 'oll-1', 'whisper'),
    ).rejects.toThrow('Ollama STT returned HTTP 500: model not found')
  })

  it('throws on network error', async () => {
    mockLoadProvidersDecrypted.mockReturnValue({
      providers: [{ id: 'oll-1', baseUrl: 'http://localhost:11434/v1', providerType: 'ollama-local' }],
    } as ReturnType<typeof loadProvidersDecrypted>)

    const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    globalThis.fetch = mockFetch

    await expect(
      transcribeOllama(Buffer.from('audio'), 'oll-1', 'whisper'),
    ).rejects.toThrow('Ollama STT request failed: ECONNREFUSED')
  })

  it('throws when response has no transcript content', async () => {
    mockLoadProvidersDecrypted.mockReturnValue({
      providers: [{ id: 'oll-1', baseUrl: 'http://localhost:11434/v1', providerType: 'ollama-local' }],
    } as ReturnType<typeof loadProvidersDecrypted>)

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ message: {} }),
    })
    globalThis.fetch = mockFetch

    await expect(
      transcribeOllama(Buffer.from('audio'), 'oll-1', 'whisper'),
    ).rejects.toThrow('Ollama STT returned no transcript content.')
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

  it('routes to openai provider', async () => {
    mockLoadConfig.mockReturnValue({
      stt: {
        enabled: true,
        provider: 'openai',
        providerId: 'oai-1',
      },
    })
    mockLoadProvidersDecrypted.mockReturnValue({
      providers: [{ id: 'oai-1', baseUrl: 'https://api.openai.com', providerType: 'openai' }],
    } as ReturnType<typeof loadProvidersDecrypted>)
    mockGetApiKeyForProvider.mockResolvedValue('sk-test')

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('openai transcription'),
    })
    globalThis.fetch = mockFetch

    const result = await transcribeAudio(Buffer.from('audio'), { language: 'English' })
    expect(result).toBe('openai transcription')
    expect(mockFetch).toHaveBeenCalledTimes(1)

    const [url] = mockFetch.mock.calls[0]
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions')
  })

  it('throws when openai provider is not configured', async () => {
    mockLoadConfig.mockReturnValue({
      stt: {
        enabled: true,
        provider: 'openai',
        providerId: '',
      },
    })

    await expect(transcribeAudio(Buffer.from('audio'))).rejects.toThrow(
      'OpenAI STT provider is not configured',
    )
  })

  it('routes to ollama provider', async () => {
    mockLoadConfig.mockReturnValue({
      stt: {
        enabled: true,
        provider: 'ollama',
        providerId: 'oll-1',
        ollamaModel: 'whisper',
      },
    })
    mockLoadProvidersDecrypted.mockReturnValue({
      providers: [{ id: 'oll-1', baseUrl: 'http://localhost:11434/v1', providerType: 'ollama-local' }],
    } as ReturnType<typeof loadProvidersDecrypted>)

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ message: { content: 'ollama transcription' } }),
    })
    globalThis.fetch = mockFetch

    const result = await transcribeAudio(Buffer.from('audio'), { language: 'German' })
    expect(result).toBe('ollama transcription')
    expect(mockFetch).toHaveBeenCalledTimes(1)

    const [url] = mockFetch.mock.calls[0]
    expect(url).toBe('http://localhost:11434/api/chat')
  })

  it('throws when ollama provider is not configured', async () => {
    mockLoadConfig.mockReturnValue({
      stt: {
        enabled: true,
        provider: 'ollama',
        providerId: '',
      },
    })

    await expect(transcribeAudio(Buffer.from('audio'))).rejects.toThrow(
      'Ollama STT provider is not configured',
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
