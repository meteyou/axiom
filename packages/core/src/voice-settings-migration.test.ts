import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { encrypt } from './encryption.js'
import { loadProviders, loadProvidersDecrypted } from './provider-config.js'
import type { ProviderConfig, ProvidersFile } from './provider-config.js'
import { migrateLegacyVoiceSettings } from './voice-settings-migration.js'

let tmpDir: string
const originalDataDir = process.env.DATA_DIR
const silent = { log: () => {}, warn: () => {} }

function openai(id: string, extra: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id,
    name: id,
    type: 'openai-completions',
    providerType: 'openai',
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    enabledModels: ['gpt-5'],
    ...extra,
  }
}

function writeProviders(file: ProvidersFile): void {
  fs.writeFileSync(path.join(tmpDir, 'config', 'providers.json'), JSON.stringify(file), 'utf-8')
}

function writeSettings(settings: object): void {
  fs.writeFileSync(path.join(tmpDir, 'config', 'settings.json'), JSON.stringify(settings), 'utf-8')
}

function readSettings(): Record<string, Record<string, unknown>> {
  return JSON.parse(fs.readFileSync(path.join(tmpDir, 'config', 'settings.json'), 'utf-8'))
}

function findProvider(id: string): ProviderConfig | undefined {
  return loadProviders().providers.find(p => p.id === id)
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-voice-migration-'))
  fs.mkdirSync(path.join(tmpDir, 'config'), { recursive: true })
  process.env.DATA_DIR = tmpDir
  writeProviders({ providers: [openai('oa')], activeProvider: 'oa', activeModel: 'gpt-5' })
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  if (originalDataDir !== undefined) process.env.DATA_DIR = originalDataDir
  else delete process.env.DATA_DIR
})

describe('migrateLegacyVoiceSettings', () => {
  it('moves OpenAI STT and TTS to voice models of the selected provider', () => {
    writeSettings({
      language: 'de',
      stt: { enabled: true, provider: 'openai', providerId: 'oa', openaiModel: 'gpt-4o-transcribe', rewrite: { enabled: true, providerId: 'oa:gpt-5' } },
      tts: { enabled: true, provider: 'openai', providerId: '', openaiModel: 'tts-1', openaiVoice: 'alloy', openaiInstructions: 'calm', responseFormat: 'opus' },
    })

    migrateLegacyVoiceSettings(silent)

    const settings = readSettings()
    expect(settings.language).toBe('de')
    expect(settings.stt).toEqual({ enabled: true, model: 'oa:gpt-4o-transcribe', rewrite: { enabled: true, providerId: 'oa:gpt-5' } })
    expect(settings.tts).toEqual({ enabled: true, model: 'oa:tts-1', voice: 'alloy', instructions: 'calm', responseFormat: 'opus' })
    expect(findProvider('oa')).toMatchObject({ enabledSttModels: ['gpt-4o-transcribe'], enabledTtsModels: ['tts-1'] })
    expect(findProvider('oa')?.status).toBeUndefined()
  })

  it('uses the fixed Mistral TTS model and keeps the voice', () => {
    writeProviders({
      providers: [openai('oa'), openai('mi', { providerType: 'mistral', provider: 'mistral', baseUrl: 'https://api.mistral.ai' })],
    })
    writeSettings({ tts: { enabled: true, provider: 'mistral', providerId: '', mistralVoice: 'v-1', openaiVoice: 'nova' } })

    migrateLegacyVoiceSettings(silent)

    expect(readSettings().tts).toEqual({ enabled: true, model: 'mi:voxtral-mini-tts-2603', voice: 'v-1' })
    expect(findProvider('mi')?.enabledTtsModels).toEqual(['voxtral-mini-tts-2603'])
  })

  it('creates one Deepgram provider from a key shared by STT and TTS', () => {
    const key = encrypt('dg-secret')
    writeSettings({
      stt: { enabled: true, provider: 'deepgram', deepgramModel: 'nova-2', deepgramLanguage: 'de', deepgramApiKey: key },
      tts: { enabled: false, provider: 'deepgram', deepgramModel: 'aura-2-julius-en', deepgramApiKey: 'dg-secret' },
    })

    migrateLegacyVoiceSettings(silent)

    const deepgram = loadProvidersDecrypted().providers.filter(p => p.providerType === 'deepgram')
    expect(deepgram).toHaveLength(1)
    expect(deepgram[0]).toMatchObject({
      name: 'Deepgram',
      apiKey: 'dg-secret',
      enabledSttModels: ['nova-2'],
      enabledTtsModels: ['aura-2-julius-en'],
    })
    const settings = readSettings()
    expect(settings.stt).toEqual({ enabled: true, model: `${deepgram[0].id}:nova-2`, language: 'de' })
    expect(settings.tts).toEqual({ enabled: false, model: `${deepgram[0].id}:aura-2-julius-en` })
    expect(loadProviders().activeProvider).toBe('oa')
  })

  it('drops Whisper URL and Ollama STT without a model', () => {
    writeSettings({ stt: { enabled: true, provider: 'whisper-url', whisperUrl: 'http://whisper', ollamaModel: 'x' } })

    migrateLegacyVoiceSettings(silent)

    expect(readSettings().stt).toEqual({ enabled: true })
    expect(findProvider('oa')?.enabledSttModels).toBeUndefined()
  })

  it('leaves untouched legacy defaults without adding voice models', () => {
    writeSettings({
      tts: { enabled: false, provider: 'openai', providerId: '', openaiModel: 'gpt-4o-mini-tts', deepgramApiKey: '' },
      stt: { enabled: false, provider: 'whisper-url', whisperUrl: '', providerId: '', deepgramApiKey: '' },
    })

    migrateLegacyVoiceSettings(silent)

    expect(readSettings()).toEqual({ tts: { enabled: false }, stt: { enabled: false } })
    expect(findProvider('oa')).toEqual(openai('oa'))
  })

  it('keeps an already selected model and does not touch migrated settings', () => {
    writeSettings({ tts: { model: 'oa:tts-1', provider: 'deepgram', deepgramApiKey: 'dg-secret' } })

    migrateLegacyVoiceSettings(silent)
    const afterFirstRun = fs.readFileSync(path.join(tmpDir, 'config', 'settings.json'), 'utf-8')
    migrateLegacyVoiceSettings(silent)

    expect(readSettings().tts).toEqual({ model: 'oa:tts-1' })
    expect(fs.readFileSync(path.join(tmpDir, 'config', 'settings.json'), 'utf-8')).toBe(afterFirstRun)
    expect(loadProviders().providers).toHaveLength(1)
  })
})
