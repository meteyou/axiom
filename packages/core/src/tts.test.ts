import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the config layer so loadTtsSettings / loadTtsDeepgramApiKey work
// without touching the real on-disk settings.json. We override the return
// values per test via `loadConfigMock.mockReturnValueOnce(...)` below.
vi.mock('./config.js', () => ({
  ensureConfigTemplates: vi.fn(),
  loadConfig: vi.fn(),
}))

// Mock Deepgram so we can assert chunk count and avoid real HTTP.
vi.mock('./deepgram.js', async () => {
  const actual = await vi.importActual<typeof import('./deepgram.js')>('./deepgram.js')
  return {
    ...actual,
    decryptDeepgramApiKey: vi.fn((s: string) => s),
    synthesizeDeepgram: vi.fn(async (text: string) => Buffer.from(`audio:${text.length}`)),
  }
})

// Provider config isn't exercised by the Deepgram path (it uses its own
// `tts.deepgramApiKey`), but `synthesizeTts` imports the module eagerly so
// we stub the loader to a no-op file.
vi.mock('./provider-config.js', async () => {
  const actual = await vi.importActual<typeof import('./provider-config.js')>('./provider-config.js')
  return {
    ...actual,
    loadProvidersDecrypted: vi.fn(() => ({ providers: [] })),
    getApiKeyForProvider: vi.fn(async () => 'test-key'),
  }
})

import { loadConfig } from './config.js'
import { synthesizeDeepgram } from './deepgram.js'
import { synthesizeTts } from './tts.js'
import type { TtsResponseFormat } from './contracts/settings.js'

const loadConfigMock = vi.mocked(loadConfig)
const synthesizeDeepgramMock = vi.mocked(synthesizeDeepgram)

function settingsFor(responseFormat: TtsResponseFormat) {
  return {
    tts: {
      enabled: true,
      provider: 'deepgram',
      providerId: '',
      responseFormat,
      deepgramModel: 'aura-2-thalia-en',
      deepgramApiKey: 'dg_test',
    },
  }
}

function mockSettings(responseFormat: TtsResponseFormat) {
  // `synthesizeTts` calls loadConfig twice: once via loadTtsSettings and
  // once via loadTtsDeepgramApiKey. Return the same payload both times.
  loadConfigMock.mockImplementation(() => settingsFor(responseFormat) as never)
}

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

  it('rejects opus input strictly longer than 2000 chars', async () => {
    mockSettings('opus')
    const text = 'a'.repeat(2001)
    await expect(synthesizeTts(text)).rejects.toThrow(/2001 chars \(>2000\)/)
    expect(synthesizeDeepgramMock).not.toHaveBeenCalled()
  })

  it('rejects flac input strictly longer than 2000 chars with an actionable message', async () => {
    mockSettings('flac')
    const text = 'a'.repeat(5000)
    await expect(synthesizeTts(text)).rejects.toThrow(/`mp3` and `wav`/)
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
    await expect(synthesizeTts(text)).resolves.toMatchObject({ contentType: 'audio/opus' })
    expect(synthesizeDeepgramMock).toHaveBeenCalledTimes(1)
  })
})
