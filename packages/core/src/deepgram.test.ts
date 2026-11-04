import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import {
  transcribeDeepgram,
  synthesizeDeepgram,
  listDeepgramModels,
} from './deepgram.js'

const STT = { model: 'nova-3' }
const TTS = { model: 'aura-2-thalia-en', encoding: 'mp3' } as const

// ── transcribeDeepgram ────────────────────────────────────────────────

describe('transcribeDeepgram', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function mockOk(transcript: string): ReturnType<typeof vi.fn> {
    return vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        results: { channels: [{ alternatives: [{ transcript }] }] },
      }),
    })
  }

  it('sends correct URL, headers, and body', async () => {
    const fetchMock = mockOk('hello world')
    globalThis.fetch = fetchMock

    const buffer = Buffer.from('fake-audio-bytes')
    const transcript = await transcribeDeepgram(buffer, 'dg-key-xyz', {
      model: 'nova-3',
      language: 'en',
    })

    expect(transcript).toEqual({ transcript: 'hello world' })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, options] = fetchMock.mock.calls[0]
    const parsed = new URL(url as string)
    expect(parsed.origin).toBe('https://api.deepgram.com')
    expect(parsed.pathname).toBe('/v1/listen')
    expect(parsed.searchParams.get('model')).toBe('nova-3')
    expect(parsed.searchParams.get('language')).toBe('en')
    expect(parsed.searchParams.get('punctuate')).toBe('true')
    expect(parsed.searchParams.get('smart_format')).toBe('true')

    expect(options.method).toBe('POST')
    expect(options.headers.Authorization).toBe('Token dg-key-xyz')
    expect(options.headers['Content-Type']).toBe('audio/ogg')
    expect(options.body).toBe(buffer)
  })

  it('omits the language when none is given', async () => {
    const fetchMock = mockOk('text')
    globalThis.fetch = fetchMock

    await transcribeDeepgram(Buffer.from('a'), 'k', STT)

    const parsed = new URL(fetchMock.mock.calls[0][0] as string)
    expect(parsed.searchParams.has('language')).toBe(false)
  })

  it('honors a custom mimeType hint', async () => {
    const fetchMock = mockOk('text')
    globalThis.fetch = fetchMock

    await transcribeDeepgram(Buffer.from('a'), 'k', { ...STT, mimeType: 'audio/wav' })

    const options = fetchMock.mock.calls[0][1]
    expect(options.headers['Content-Type']).toBe('audio/wav')
  })

  it('honors a custom baseUrl (e.g. for self-hosted proxies / tests)', async () => {
    const fetchMock = mockOk('text')
    globalThis.fetch = fetchMock

    await transcribeDeepgram(Buffer.from('a'), 'k', { ...STT, baseUrl: 'https://proxy.example.com/' })

    const [url] = fetchMock.mock.calls[0]
    const parsed = new URL(url as string)
    expect(parsed.origin).toBe('https://proxy.example.com')
    expect(parsed.pathname).toBe('/v1/listen')
  })

  it('trims whitespace from the transcript', async () => {
    const fetchMock = mockOk('   hi   \n')
    globalThis.fetch = fetchMock

    const result = await transcribeDeepgram(Buffer.from('a'), 'k', STT)
    expect(result.transcript).toBe('hi')
  })

  it('returns an empty transcript when Deepgram heard nothing', async () => {
    globalThis.fetch = mockOk('')

    const result = await transcribeDeepgram(Buffer.from('a'), 'k', STT)
    expect(result.transcript).toBe('')
  })

  it('throws when the API key is empty', async () => {
    await expect(transcribeDeepgram(Buffer.from('a'), '', STT)).rejects.toThrow(
      /API key is not configured/,
    )
  })

  it('throws when the buffer is empty', async () => {
    await expect(transcribeDeepgram(Buffer.alloc(0), 'k', STT)).rejects.toThrow(
      /audio buffer is empty/,
    )
  })

  it('reports auth failures clearly on 401', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('Unauthorized'),
    })

    await expect(transcribeDeepgram(Buffer.from('a'), 'bad-key', STT)).rejects.toThrow(
      /authentication failed.*HTTP 401/,
    )
  })

  it('reports rate-limit failures clearly on 429', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: () => Promise.resolve('Too Many Requests'),
    })

    await expect(transcribeDeepgram(Buffer.from('a'), 'k', STT)).rejects.toThrow(
      /rate-limited.*HTTP 429/,
    )
  })

  it('wraps network errors in a deterministic message', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))

    await expect(transcribeDeepgram(Buffer.from('a'), 'k', STT)).rejects.toThrow(
      /Deepgram STT request failed: ECONNREFUSED/,
    )
  })

  it('throws when the response is malformed (no transcript field)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ results: { channels: [] } }),
    })

    await expect(transcribeDeepgram(Buffer.from('a'), 'k', STT)).rejects.toThrow(
      /did not contain a transcript/,
    )
  })
})

// ── synthesizeDeepgram ────────────────────────────────────────────────

describe('synthesizeDeepgram', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function mockAudio(bytes: Uint8Array): ReturnType<typeof vi.fn> {
    return vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: () => Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
    })
  }

  it('sends correct URL, headers, and JSON body', async () => {
    const audioBytes = new Uint8Array([1, 2, 3, 4])
    const fetchMock = mockAudio(audioBytes)
    globalThis.fetch = fetchMock

    const audio = await synthesizeDeepgram('Hello world', 'dg-key', {
      model: 'aura-2-thalia-en',
      encoding: 'mp3',
    })

    expect(audio).toBeInstanceOf(Buffer)
    expect(audio.length).toBe(4)
    expect(Array.from(audio)).toEqual([1, 2, 3, 4])
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, options] = fetchMock.mock.calls[0]
    const parsed = new URL(url as string)
    expect(parsed.origin).toBe('https://api.deepgram.com')
    expect(parsed.pathname).toBe('/v1/speak')
    expect(parsed.searchParams.get('model')).toBe('aura-2-thalia-en')
    expect(parsed.searchParams.get('encoding')).toBe('mp3')
    expect(parsed.searchParams.has('container')).toBe(false)

    expect(options.method).toBe('POST')
    expect(options.headers.Authorization).toBe('Token dg-key')
    expect(options.headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(options.body)).toEqual({ text: 'Hello world' })
  })

  it('requests headerless PCM for linear16', async () => {
    const fetchMock = mockAudio(new Uint8Array([0]))
    globalThis.fetch = fetchMock

    await synthesizeDeepgram('hi', 'k', { ...TTS, encoding: 'linear16' })

    const parsed = new URL(fetchMock.mock.calls[0][0] as string)
    expect(parsed.searchParams.get('encoding')).toBe('linear16')
    expect(parsed.searchParams.get('container')).toBe('none')
  })

  it('trims input text before sending', async () => {
    const fetchMock = mockAudio(new Uint8Array([0]))
    globalThis.fetch = fetchMock

    await synthesizeDeepgram('   hello   ', 'k', TTS)

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.text).toBe('hello')
  })

  it('rejects empty input', async () => {
    await expect(synthesizeDeepgram('   ', 'k', TTS)).rejects.toThrow(/input text is empty/)
  })

  it('rejects missing API key', async () => {
    await expect(synthesizeDeepgram('hi', '', TTS)).rejects.toThrow(/API key is not configured/)
  })

  it('reports auth failure on 401', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('Bad key'),
    })

    await expect(synthesizeDeepgram('hi', 'bad', TTS)).rejects.toThrow(
      /authentication failed.*HTTP 401/,
    )
  })

  it('reports rate-limit on 429', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: () => Promise.resolve('slow down'),
    })

    await expect(synthesizeDeepgram('hi', 'k', TTS)).rejects.toThrow(/rate-limited.*HTTP 429/)
  })

  it('reports upstream errors on 5xx', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: () => Promise.resolve('try again later'),
    })

    await expect(synthesizeDeepgram('hi', 'k', TTS)).rejects.toThrow(/upstream error.*HTTP 503/)
  })

  it('wraps network errors with context', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ENOTFOUND'))

    await expect(synthesizeDeepgram('hi', 'k', TTS)).rejects.toThrow(
      /Deepgram TTS request failed: ENOTFOUND/,
    )
  })
})

// ── listDeepgramModels ─────────────────────────────────────────────────

describe('listDeepgramModels', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => { originalFetch = globalThis.fetch })
  afterEach(() => { globalThis.fetch = originalFetch })

  function mockJson(payload: unknown) {
    return vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(payload),
    })
  }

  it('GETs /v1/models with the bearer token and returns parsed lists', async () => {
    const fetchMock = mockJson({
      stt: [{
        name: 'Nova-3',
        canonical_name: 'nova-3-general',
        architecture: 'nova-3',
        languages: ['en'],
        version: '2024-12-09.0',
        uuid: 'uuid-stt-1',
        batch: true,
        streaming: true,
        formatted_output: true,
      }],
      tts: [{
        name: 'Aura-2 — Thalia',
        canonical_name: 'aura-2-thalia-en',
        architecture: 'aura-2',
        languages: ['en'],
        version: '2024-11-01.0',
        uuid: 'uuid-tts-1',
      }],
    })
    globalThis.fetch = fetchMock

    const result = await listDeepgramModels('test-key')

    expect(result.stt).toHaveLength(1)
    expect(result.stt[0]?.canonical_name).toBe('nova-3-general')
    expect(result.tts).toHaveLength(1)
    expect(result.tts[0]?.canonical_name).toBe('aura-2-thalia-en')

    const [url, options] = fetchMock.mock.calls[0]
    const parsed = new URL(url as string)
    expect(parsed.origin).toBe('https://api.deepgram.com')
    expect(parsed.pathname).toBe('/v1/models')
    expect(parsed.search).toBe('')
    expect(options.method).toBe('GET')
    expect(options.headers.Authorization).toBe('Token test-key')
  })

  it('returns empty arrays when one of the categories is missing', async () => {
    globalThis.fetch = mockJson({ stt: [{ canonical_name: 'nova-3' }] })

    const result = await listDeepgramModels('k')
    expect(result.stt).toHaveLength(1)
    expect(result.tts).toEqual([])
  })

  it('rejects missing API key', async () => {
    await expect(listDeepgramModels('')).rejects.toThrow(/API key is not configured/)
  })

  it('reports auth failure on 401', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('Bad key'),
    })

    await expect(listDeepgramModels('bad')).rejects.toThrow(/authentication failed.*HTTP 401/)
  })

  it('wraps network errors with context', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ENOTFOUND'))

    await expect(listDeepgramModels('k')).rejects.toThrow(/Deepgram models request failed: ENOTFOUND/)
  })

  it('falls back to empty arrays for malformed payloads', async () => {
    globalThis.fetch = mockJson(['not', 'an', 'object'])

    const result = await listDeepgramModels('k')
    expect(result).toEqual({ stt: [], tts: [] })
  })
})
