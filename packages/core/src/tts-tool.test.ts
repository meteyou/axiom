import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./tts.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./tts.js')>()
  return {
    ...original,
    loadTtsSettings: vi.fn(),
    getTtsModelResponseFormats: vi.fn(),
    synthesizeTts: vi.fn(),
  }
})

vi.mock('./uploads.js', () => ({
  saveUpload: vi.fn((input: { originalName: string; mimeType: string; buffer: Buffer }) => ({
    kind: 'file',
    originalName: input.originalName,
    storedName: `abc-${input.originalName}`,
    relativePath: `2026/01/01/abc-${input.originalName}`,
    urlPath: `/api/uploads/2026/01/01/abc-${input.originalName}`,
    mimeType: input.mimeType,
    size: input.buffer.length,
  })),
}))

import type { TtsResponseFormat } from './contracts/settings.js'
import { getTtsModelResponseFormats, loadTtsSettings, synthesizeTts } from './tts.js'
import type { TtsSettings } from './tts.js'
import { createSendVoiceMessageTool, createSendVoiceMessageTools } from './tts-tool.js'
import type { SendVoiceMessageToolOptions } from './tts-tool.js'
import { saveUpload } from './uploads.js'

const mockLoadTtsSettings = vi.mocked(loadTtsSettings)
const mockFormats = vi.mocked(getTtsModelResponseFormats)
const mockSynthesize = vi.mocked(synthesizeTts)
const mockSaveUpload = vi.mocked(saveUpload)

const ALL_FORMATS: TtsResponseFormat[] = ['mp3', 'wav', 'opus', 'flac']
const EXTENSIONS: Record<TtsResponseFormat, string> = { mp3: 'mp3', wav: 'wav', opus: 'ogg', flac: 'flac' }

function useSettings(overrides: Partial<TtsSettings> = {}) {
  mockLoadTtsSettings.mockReturnValue({
    enabled: true,
    model: 'oai:gpt-4o-mini-tts',
    voice: '',
    instructions: '',
    responseFormat: 'mp3',
    agentTool: true,
    ...overrides,
  })
}

function options(channel?: string): SendVoiceMessageToolOptions {
  return {
    getCurrentUserId: () => 7,
    getCurrentInteractiveSessionId: () => 'session-1',
    getChannel: () => channel,
  }
}

function properties(tool: { parameters: unknown }): Record<string, { description?: string; enum?: string[] }> {
  return (tool.parameters as { properties: Record<string, { description?: string; enum?: string[] }> }).properties
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return (result.content[0] as { type: 'text'; text: string }).text
}

beforeEach(() => {
  vi.clearAllMocks()
  useSettings()
  mockFormats.mockReturnValue(ALL_FORMATS)
  mockSynthesize.mockImplementation(async (_text, opts) => {
    const format = opts?.settings?.responseFormat ?? 'mp3'
    return { audio: Buffer.from('audio'), contentType: format === 'opus' ? 'audio/ogg' : `audio/${format}`, extension: EXTENSIONS[format] }
  })
})

describe('createSendVoiceMessageTools', () => {
  it('offers the tool only when TTS is enabled, offered to the agent and has a model', () => {
    expect(createSendVoiceMessageTools(options()).map(tool => tool.name)).toEqual(['send_voice_message'])
    useSettings({ agentTool: false })
    expect(createSendVoiceMessageTools(options())).toEqual([])
    useSettings({ enabled: false })
    expect(createSendVoiceMessageTools(options())).toEqual([])
    useSettings({ model: '' })
    expect(createSendVoiceMessageTools(options())).toEqual([])
  })
})

describe('send_voice_message declaration', () => {
  it('offers exactly the formats of the provider and the Telegram opus hint', () => {
    const format = properties(createSendVoiceMessageTool(options()))['format']!
    expect(format.enum).toEqual(ALL_FORMATS)
    expect(format.description).toContain('Default: mp3')
    expect(format.description).toContain('For Telegram replies use "opus"')
  })

  it('drops the opus hint when the provider cannot return opus', () => {
    mockFormats.mockReturnValue(['mp3', 'wav'])
    const format = properties(createSendVoiceMessageTool(options()))['format']!
    expect(format.enum).toEqual(['mp3', 'wav'])
    expect(format.description).not.toContain('opus')
  })

  it('omits the format parameter when the provider returns a single format', () => {
    mockFormats.mockReturnValue(['mp3'])
    expect(Object.keys(properties(createSendVoiceMessageTool(options())))).toEqual(['text'])
  })
})

describe('send_voice_message execute', () => {
  it('speaks the text without markdown and attaches a voice upload', async () => {
    const result = await createSendVoiceMessageTool(options('web')).execute('id', { text: '**Hello** `world`' })

    expect(mockSynthesize).toHaveBeenCalledWith('Hello world', { settings: { responseFormat: 'mp3' } })
    expect(mockSaveUpload).toHaveBeenCalledWith(expect.objectContaining({
      originalName: 'voice-message.mp3',
      mimeType: 'audio/mp3',
      userId: 7,
      sessionId: 'session-1',
      source: 'web',
    }))
    expect(result.details).toMatchObject({ format: 'mp3', uploadedFile: { originalName: 'voice-message.mp3', voiceMessage: true } })
    expect(textOf(result)).toContain('as an audio player in the chat')
  })

  it('defaults to opus on Telegram when the provider supports it', async () => {
    const result = await createSendVoiceMessageTool(options('telegram')).execute('id', { text: 'Hallo' })
    expect(mockSynthesize).toHaveBeenCalledWith('Hallo', { settings: { responseFormat: 'opus' } })
    expect(textOf(result)).toContain('as a Telegram voice message')
  })

  it('falls back to mp3 on Telegram without opus', async () => {
    mockFormats.mockReturnValue(['mp3', 'wav'])
    useSettings({ responseFormat: 'wav' })
    await createSendVoiceMessageTool(options('telegram')).execute('id', { text: 'Hallo' })
    expect(mockSynthesize).toHaveBeenCalledWith('Hallo', { settings: { responseFormat: 'mp3' } })
  })

  it('honours a supported requested format and ignores an unsupported one', async () => {
    const tool = createSendVoiceMessageTool(options('telegram'))
    const wav = await tool.execute('id', { text: 'Hi', format: 'wav' })
    expect(mockSynthesize).toHaveBeenLastCalledWith('Hi', { settings: { responseFormat: 'wav' } })
    expect(textOf(wav)).toContain('as a Telegram audio file')

    mockFormats.mockReturnValue(['mp3'])
    await tool.execute('id', { text: 'Hi', format: 'flac' })
    expect(mockSynthesize).toHaveBeenLastCalledWith('Hi', { settings: { responseFormat: 'mp3' } })
  })

  it('rejects empty and overly long texts', async () => {
    const tool = createSendVoiceMessageTool(options())
    expect(textOf(await tool.execute('id', { text: '```code only```' }))).toBe('Error: text is empty.')
    expect(textOf(await tool.execute('id', { text: 'a'.repeat(4001) }))).toContain('max 4000')
    expect(mockSynthesize).not.toHaveBeenCalled()
  })

  it('refuses when the tool was switched off since the declaration', async () => {
    const tool = createSendVoiceMessageTool(options())
    useSettings({ agentTool: false })
    const result = await tool.execute('id', { text: 'Hi' })
    expect(result.details).toEqual({ error: true })
    expect(textOf(result)).toContain('not enabled')
  })

  it('reports synthesis failures', async () => {
    mockSynthesize.mockRejectedValue(new Error('TTS model "x" is not enabled'))
    const result = await createSendVoiceMessageTool(options()).execute('id', { text: 'Hi' })
    expect(textOf(result)).toBe('Error creating voice message: TTS model "x" is not enabled')
    expect(result.details).toEqual({ error: true })
  })
})
