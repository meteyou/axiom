import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import nodePath from 'node:path'

vi.mock('./config.js', () => ({
  loadConfig: vi.fn(),
  ensureConfigTemplates: vi.fn(),
}))

vi.mock('./workspace.js', () => ({
  getWorkspaceDir: vi.fn(() => '/workspace'),
}))

vi.mock('./stt.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>
  return {
    ...original,
    loadSttSettings: vi.fn(),
    transcribeAudio: vi.fn(),
  }
})

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}))

vi.mock('./provider-config.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>
  return {
    ...original,
    loadProviders: vi.fn(() => ({
      providers: [
        { id: 'p1', providerType: 'openai' },
        { id: 'dg', providerType: 'deepgram' },
      ],
    })),
  }
})

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>
  return {
    ...original,
    default: {
      ...original.default as Record<string, unknown>,
      existsSync: vi.fn(),
      accessSync: vi.fn(),
      readFileSync: vi.fn(),
      statSync: vi.fn(),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
    },
  }
})

import { execFile } from 'node:child_process'
import { createTranscribeAudioTool, createTranscribeAudioTools } from './stt-tool.js'
import { loadSttSettings, transcribeAudio } from './stt.js'
import type { SttSettings } from './stt.js'

const mockLoadSttSettings = vi.mocked(loadSttSettings)
const mockTranscribeAudio = vi.mocked(transcribeAudio)
const mockExistsSync = vi.mocked(fs.existsSync)
const mockAccessSync = vi.mocked(fs.accessSync)
const mockReadFileSync = vi.mocked(fs.readFileSync)
const mockStatSync = vi.mocked(fs.statSync)
const mockWriteFileSync = vi.mocked(fs.writeFileSync)

function settings(overrides: Partial<SttSettings> = {}): SttSettings {
  return {
    enabled: true,
    model: 'p1:whisper-1',
    language: '',
    rewrite: { enabled: false, providerId: '' },
    agentTool: true,
    ...overrides,
  }
}

const REWRITE_ON = { rewrite: { enabled: true, providerId: 'prov-1:gpt-4o' } }

function useSettings(overrides: Partial<SttSettings> = {}) {
  mockLoadSttSettings.mockReturnValue(settings(overrides))
}

function fileExists(content = 'fake-audio') {
  mockExistsSync.mockReturnValue(true)
  mockAccessSync.mockReturnValue(undefined)
  mockReadFileSync.mockReturnValue(Buffer.from(content))
  mockStatSync.mockReturnValue({ size: Buffer.byteLength(content) } as fs.Stats)
}

/** Stands in for a 30 MB MP3; a real buffer that size overwhelms the mock call recording. */
function oversizedAudio(): Buffer {
  return { length: 30 * 1024 * 1024 } as Buffer
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return (result.content[0] as { type: 'text'; text: string }).text
}

beforeEach(() => {
  vi.clearAllMocks()
  useSettings()
})

describe('createTranscribeAudioTools', () => {
  it('offers the tool only when STT is enabled, offered to the agent and has a model', () => {
    expect(createTranscribeAudioTools().map(tool => tool.name)).toEqual(['audio_transcribe'])

    useSettings({ agentTool: false })
    expect(createTranscribeAudioTools()).toEqual([])
    useSettings({ enabled: false })
    expect(createTranscribeAudioTools()).toEqual([])
    useSettings({ model: '' })
    expect(createTranscribeAudioTools()).toEqual([])
  })
})

describe('createTranscribeAudioTool', () => {
  it('creates a tool with correct metadata', () => {
    const tool = createTranscribeAudioTool()
    expect(tool.name).toBe('audio_transcribe')
    expect(tool.label).toBe('Transcribe Audio')
    expect(tool.description).toContain('speech-to-text')
    expect(tool.description).toContain('video')
  })

  it('declares no rewrite parameter without a configured rewrite model', () => {
    const schema = createTranscribeAudioTool().parameters as { properties: Record<string, unknown>; required?: string[] }
    expect(Object.keys(schema.properties)).toEqual(['path', 'language'])
    expect(schema.required).toEqual(['path'])

    const enabledWithoutModel = createTranscribeAudioTool({ settings: settings({ rewrite: { enabled: true, providerId: '' } }) })
    expect((enabledWithoutModel.parameters as { properties: Record<string, unknown> }).properties.rewrite).toBeUndefined()
  })

  it('declares an optional rewrite parameter when the rewrite is configured', () => {
    const tool = createTranscribeAudioTool({ settings: settings(REWRITE_ON) })
    const schema = tool.parameters as { properties: Record<string, { description?: string }>; required?: string[] }
    expect(schema.properties.rewrite?.description).toContain('Default: false')
    expect(schema.required).toEqual(['path'])
  })
})

describe('audio_transcribe execute', () => {
  it('transcribes a valid mp3 file without rewriting', async () => {
    useSettings(REWRITE_ON)
    fileExists()
    mockTranscribeAudio.mockResolvedValue({ transcript: 'Hello world, this is a transcription.' })

    const result = await createTranscribeAudioTool().execute('test-id', { path: 'audio/recording.mp3' })

    expect(textOf(result)).toBe('Hello world, this is a transcription.')
    expect(result.details).toMatchObject({
      path: nodePath.resolve('/workspace', 'audio/recording.mp3'),
      filename: 'recording.mp3',
      mimeType: 'audio/mpeg',
      rewrite: false,
    })
    expect(mockTranscribeAudio).toHaveBeenCalledWith(Buffer.from('fake-audio'), {
      language: undefined,
      filename: 'recording.mp3',
      rewrite: false,
    })
  })

  it('books the transcription on the current session and user', async () => {
    fileExists()
    mockTranscribeAudio.mockResolvedValue({ transcript: 'Hi' })
    const db = {} as import('./database.js').Database
    const tool = createTranscribeAudioTool({ usage: { db, getSessionId: () => 'sess-9', getUserId: () => 4 } })

    await tool.execute('test-id', { path: 'a.mp3' })

    expect(mockTranscribeAudio).toHaveBeenCalledWith(expect.any(Buffer), expect.objectContaining({
      usage: { db, sessionId: 'sess-9', userId: 4 },
    }))
  })

  it('resolves relative paths against the given user workspace', async () => {
    fileExists()
    mockTranscribeAudio.mockResolvedValue({ transcript: 'Hi' })

    const tool = createTranscribeAudioTool({ getWorkspaceDir: () => '/workspace/bob' })
    const result = await tool.execute('test-id', { path: 'audio/recording.mp3' })

    expect(result.details.path).toBe(nodePath.resolve('/workspace/bob', 'audio/recording.mp3'))
  })

  it('passes the language parameter through', async () => {
    fileExists('fake-wav')
    mockTranscribeAudio.mockResolvedValue({ transcript: 'Hallo Welt' })

    const result = await createTranscribeAudioTool().execute('test-id', { path: 'audio.wav', language: 'de' })

    expect(textOf(result)).toBe('Hallo Welt')
    expect(result.details).toMatchObject({ language: 'de', mimeType: 'audio/wav' })
    expect(mockTranscribeAudio).toHaveBeenCalledWith(Buffer.from('fake-wav'), { language: 'de', filename: 'audio.wav', rewrite: false })
  })

  it('rewrites when requested and configured', async () => {
    useSettings(REWRITE_ON)
    fileExists()
    mockTranscribeAudio.mockResolvedValue({ transcript: 'um so like hello world', rewritten: 'hello world' })

    const result = await createTranscribeAudioTool().execute('test-id', { path: 'test.ogg', rewrite: true })

    expect(textOf(result)).toBe('hello world')
    expect(result.details.rewrite).toBe(true)
    expect(mockTranscribeAudio).toHaveBeenCalledWith(expect.any(Buffer), expect.objectContaining({ rewrite: true }))
  })

  it('ignores a rewrite request when no rewrite is configured', async () => {
    fileExists()
    mockTranscribeAudio.mockResolvedValue({ transcript: 'raw transcript' })

    const result = await createTranscribeAudioTool().execute('test-id', { path: 'test.webm', rewrite: true })

    expect(textOf(result)).toBe('raw transcript')
    expect(result.details.rewrite).toBe(false)
    expect(mockTranscribeAudio).toHaveBeenCalledWith(expect.any(Buffer), expect.objectContaining({ rewrite: false }))
  })

  it('returns the raw transcript with a note when the rewrite fails', async () => {
    useSettings(REWRITE_ON)
    fileExists()
    mockTranscribeAudio.mockResolvedValue({ transcript: 'raw transcript', rewriteError: 'HTTP 500' })

    const result = await createTranscribeAudioTool().execute('test-id', { path: 'test.m4a', rewrite: true })

    expect(textOf(result)).toBe('raw transcript\n\nNote: the rewrite failed (HTTP 500); this is the raw transcript.')
    expect(result.details).toMatchObject({ rewrite: false, rewriteError: 'HTTP 500' })
  })

  it('supports all audio extensions', async () => {
    const expected: Record<string, string> = {
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.ogg': 'audio/ogg',
      '.webm': 'audio/webm',
      '.m4a': 'audio/mp4',
      '.flac': 'audio/flac',
    }
    fileExists()
    mockTranscribeAudio.mockResolvedValue({ transcript: 'text' })

    for (const [ext, mime] of Object.entries(expected)) {
      const result = await createTranscribeAudioTool().execute('test-id', { path: `file${ext}` })
      expect(result.details.mimeType).toBe(mime)
      expect(result.details.error).toBeUndefined()
    }
  })

  it('extracts the audio track of video files', async () => {
    fileExists()
    const extractAudio = vi.fn(async () => Buffer.from('extracted'))
    mockTranscribeAudio.mockResolvedValue({ transcript: 'from the video' })

    const result = await createTranscribeAudioTool({ extractAudio }).execute('test-id', { path: 'clips/talk.mp4' })

    expect(textOf(result)).toBe('from the video')
    expect(extractAudio).toHaveBeenCalledWith(nodePath.resolve('/workspace', 'clips/talk.mp4'))
    expect(mockReadFileSync).not.toHaveBeenCalled()
    expect(mockTranscribeAudio).toHaveBeenCalledWith(Buffer.from('extracted'), expect.objectContaining({ filename: 'talk.mp3' }))
    expect(result.details).toMatchObject({ mimeType: 'video/mp4', audioExtracted: true })
  })

  it('lets ffmpeg open only local files', async () => {
    fileExists()
    vi.mocked(execFile).mockImplementation(((_cmd: string, _args: string[], _opts: object, callback: (err: Error | null) => void) => {
      callback(null)
    }) as unknown as typeof execFile)
    mockTranscribeAudio.mockResolvedValue({ transcript: 'from the video' })

    await createTranscribeAudioTool().execute('test-id', { path: 'clips/talk.mp4' })

    const args = vi.mocked(execFile).mock.calls[0]?.[1] as string[]
    expect(args.slice(0, args.indexOf('-i') + 2)).toEqual([
      '-nostdin', '-y', '-protocol_whitelist', 'file', '-i', nodePath.resolve('/workspace', 'clips/talk.mp4'),
    ])
    expect(mockTranscribeAudio).toHaveBeenCalled()
  })

  it('re-encodes audio files that exceed the upload limit', async () => {
    fileExists()
    mockStatSync.mockReturnValue({ size: 25 * 1024 * 1024 } as fs.Stats)
    const extractAudio = vi.fn(async () => Buffer.from('compressed'))
    mockTranscribeAudio.mockResolvedValue({ transcript: 'long talk' })

    await createTranscribeAudioTool({ extractAudio }).execute('test-id', { path: 'big.wav' })

    expect(mockReadFileSync).not.toHaveBeenCalled()
    expect(mockTranscribeAudio).toHaveBeenCalledWith(Buffer.from('compressed'), expect.objectContaining({ filename: 'big.mp3' }))
  })

  it('refuses re-encoded audio above the upload limit with split instructions', async () => {
    fileExists()
    const extractAudio = vi.fn(async () => oversizedAudio())

    const result = await createTranscribeAudioTool({ extractAudio }).execute('test-id', { path: 'podcast.mp4' })

    expect(result.details).toEqual({ error: true })
    expect(textOf(result)).toMatch(/about 131 minutes long.*about 104 minutes per file/)
    expect(textOf(result)).toContain('-f segment -segment_time 5400')
    expect(mockTranscribeAudio).not.toHaveBeenCalled()
  })

  it('uploads long re-encoded audio to Deepgram without the size limit', async () => {
    useSettings({ model: 'dg:nova-3' })
    fileExists()
    const audio = oversizedAudio()
    mockTranscribeAudio.mockResolvedValue({ transcript: 'long podcast' })

    const result = await createTranscribeAudioTool({ extractAudio: vi.fn(async () => audio) }).execute('test-id', { path: 'podcast.mp4' })

    expect(textOf(result)).toBe('long podcast')
    expect(mockTranscribeAudio.mock.calls[0]?.[0]).toBe(audio)
  })

  it('saves long transcripts to a workspace file and returns a preview', async () => {
    fileExists()
    const transcript = 'word '.repeat(5000)
    mockTranscribeAudio.mockResolvedValue({ transcript })

    const result = await createTranscribeAudioTool().execute('test-id', { path: 'podcast.mp3' })

    const [target, written] = mockWriteFileSync.mock.calls[0]!
    expect(String(target)).toMatch(/^\/workspace\/transcripts\/podcast-.+\.txt$/)
    expect(written).toBe(transcript)
    expect(result.details.transcriptPath).toBe(target)
    expect(textOf(result)).toContain(`saved to ${String(target)}`)
    expect(textOf(result).length).toBeLessThan(3000)
  })
})

describe('audio_transcribe error handling', () => {
  it('returns error when STT is not enabled', async () => {
    useSettings({ enabled: false })
    const result = await createTranscribeAudioTool().execute('test-id', { path: 'test.mp3' })
    expect(textOf(result)).toContain('not enabled')
    expect(result.details.error).toBe(true)
  })

  it('returns error when file does not exist', async () => {
    mockExistsSync.mockReturnValue(false)
    const result = await createTranscribeAudioTool().execute('test-id', { path: 'nonexistent.mp3' })
    expect(textOf(result)).toContain('File not found')
    expect(result.details.error).toBe(true)
  })

  it('returns error when file is not readable', async () => {
    mockExistsSync.mockReturnValue(true)
    mockAccessSync.mockImplementation(() => { throw new Error('EACCES') })
    const result = await createTranscribeAudioTool().execute('test-id', { path: 'protected.mp3' })
    expect(textOf(result)).toContain('not readable')
    expect(result.details.error).toBe(true)
  })

  it('returns error for unsupported formats', async () => {
    fileExists()
    const result = await createTranscribeAudioTool().execute('test-id', { path: 'notes.txt' })
    expect(textOf(result)).toContain('Unsupported file format ".txt"')
    expect(textOf(result)).toContain('.mp4')
    expect(result.details.error).toBe(true)
  })

  it('returns error when the audio extraction fails', async () => {
    fileExists()
    const extractAudio = vi.fn(async () => { throw new Error('ffmpeg is not installed.') })
    const result = await createTranscribeAudioTool({ extractAudio }).execute('test-id', { path: 'clip.mov' })
    expect(textOf(result)).toBe('Error transcribing audio: ffmpeg is not installed.')
    expect(result.details.error).toBe(true)
  })

  it('returns error when transcription fails', async () => {
    fileExists()
    mockTranscribeAudio.mockRejectedValue(new Error('OpenAI STT returned HTTP 500. Internal Server Error'))
    const result = await createTranscribeAudioTool().execute('test-id', { path: 'bad.mp3' })
    expect(textOf(result)).toContain('Error transcribing audio')
    expect(textOf(result)).toContain('HTTP 500')
    expect(result.details.error).toBe(true)
  })

  it('handles absolute paths', async () => {
    fileExists()
    mockTranscribeAudio.mockResolvedValue({ transcript: 'transcript' })
    const result = await createTranscribeAudioTool().execute('test-id', { path: '/tmp/audio.mp3' })
    expect(result.details.path).toBe('/tmp/audio.mp3')
    expect(result.details.error).toBeUndefined()
  })
})
