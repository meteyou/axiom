import { afterEach, describe, expect, it, vi } from 'vitest'
import { audioFormatFromFilename, clearVoiceModelListCache, getVoiceBackend, voiceApiRoot } from './voice-backends.js'
import type { VoiceRequestContext } from './voice-backends.js'

function ctx(baseUrl: string, body: unknown): { context: VoiceRequestContext; fetchImpl: ReturnType<typeof vi.fn> } {
  const fetchImpl = vi.fn().mockImplementation(async () => new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  }))
  return { context: { baseUrl, apiKey: 'key', fetchImpl: fetchImpl as unknown as typeof fetch }, fetchImpl }
}

afterEach(() => clearVoiceModelListCache())

describe('voice backend helpers', () => {
  it('appends /v1 only when the base URL has no version segment', () => {
    expect(voiceApiRoot('https://api.mistral.ai')).toBe('https://api.mistral.ai/v1')
    expect(voiceApiRoot('https://api.openai.com/v1/')).toBe('https://api.openai.com/v1')
    expect(voiceApiRoot('https://openrouter.ai/api/v1')).toBe('https://openrouter.ai/api/v1')
  })

  it('derives the audio format from the filename', () => {
    expect(audioFormatFromFilename('voice.oga')).toBe('ogg')
    expect(audioFormatFromFilename('clip.MP4')).toBe('m4a')
    expect(audioFormatFromFilename(undefined)).toBe('webm')
  })
})

describe('voice model listing', () => {
  it('recognizes OpenAI voice models by id and skips realtime models', async () => {
    const { context } = ctx('https://api.openai.com/v1', {
      data: [{ id: 'gpt-4o' }, { id: 'whisper-1' }, { id: 'gpt-4o-transcribe' }, { id: 'tts-1-hd' }, { id: 'gpt-4o-mini-tts' }, { id: 'gpt-realtime-transcribe' }],
    })
    const backend = getVoiceBackend('openai')
    expect((await backend.listModels(context, 'stt')).map(m => m.id)).toEqual(['gpt-4o-transcribe', 'whisper-1'])
    expect((await backend.listModels(context, 'tts')).map(m => m.id)).toEqual(['gpt-4o-mini-tts', 'tts-1-hd'])
    expect((await backend.listVoices!(context, 'tts-1-hd')).map(v => v.id)).not.toContain('marin')
    expect((await backend.listVoices!(context, 'gpt-4o-mini-tts')).map(v => v.id)).toContain('marin')
  })

  it('offers every model of an OpenAI-compatible server and a free-text voice', async () => {
    const { context } = ctx('http://kokoro:8880/v1', { data: [{ id: 'kokoro' }, { id: 'faster-whisper' }] })
    const backend = getVoiceBackend('openai-compatible')
    expect((await backend.listModels(context, 'tts')).map(m => m.id)).toEqual(['faster-whisper', 'kokoro'])
    expect(await backend.listVoices!(context, 'kokoro')).toEqual([])
  })

  it('filters Mistral models by their audio capabilities', async () => {
    const { context, fetchImpl } = ctx('https://api.mistral.ai', {
      data: [
        { id: 'mistral-large-latest', capabilities: { completion_chat: true } },
        { id: 'voxtral-mini-latest', name: 'Voxtral Mini', capabilities: { audio_transcription: true } },
        { id: 'voxtral-mini-tts-2603', capabilities: { audio_speech: true } },
      ],
    })
    const backend = getVoiceBackend('mistral')
    expect(await backend.listModels(context, 'stt')).toEqual([{ id: 'voxtral-mini-latest', name: 'Voxtral Mini' }])
    expect((await backend.listModels(context, 'tts')).map(m => m.id)).toEqual(['voxtral-mini-tts-2603'])
    expect(fetchImpl.mock.calls[0]![0]).toBe('https://api.mistral.ai/v1/models')
  })

  it('lists OpenRouter models per modality with prices and per-model voices', async () => {
    const { context, fetchImpl } = ctx('https://openrouter.ai/api/v1', {
      data: [
        { id: 'deepgram/aura-2', name: 'Deepgram: Aura-2', pricing: { prompt: '0.00003', completion: '0' }, supported_voices: ['aura-2-thalia-en'] },
        { id: 'google/gemini-tts', name: 'Gemini TTS', pricing: { prompt: '0.0000005', completion: '0.000009' } },
      ],
    })
    const backend = getVoiceBackend('openrouter')
    expect(await backend.listModels(context, 'tts')).toEqual([
      { id: 'deepgram/aura-2', name: 'Deepgram: Aura-2', costPerMillion: 30 },
      { id: 'google/gemini-tts', name: 'Gemini TTS' },
    ])
    expect(await backend.listVoices!(context, 'deepgram/aura-2')).toEqual([{ id: 'aura-2-thalia-en', name: 'aura-2-thalia-en' }])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl.mock.calls[0]![0]).toBe('https://openrouter.ai/api/v1/models?output_modalities=speech')
  })

  it('collapses Deepgram language variants per canonical name', async () => {
    const { context, fetchImpl } = ctx('https://api.deepgram.com', {
      stt: [
        { canonical_name: 'nova-3', languages: ['en'] },
        { canonical_name: 'nova-3', languages: ['de', 'en'] },
      ],
      tts: [{ canonical_name: 'aura-2-thalia-en', languages: ['en-US'], metadata: { accent: 'American' } }],
    })
    const backend = getVoiceBackend('deepgram')
    expect(await backend.listModels(context, 'stt')).toEqual([{ id: 'nova-3', name: 'nova-3', languages: ['en', 'de'] }])
    expect(await backend.listModels(context, 'tts')).toEqual([
      { id: 'aura-2-thalia-en', name: 'aura-2-thalia-en', description: 'American', languages: ['en-US'] },
    ])
    expect(backend.listVoices).toBeUndefined()
    expect((fetchImpl.mock.calls[0]![1] as RequestInit).headers).toMatchObject({ Authorization: 'Token key' })
  })

  it('falls back to the known xAI transcription models when the live list has none', async () => {
    const { context } = ctx('https://api.x.ai/v1', { data: [{ id: 'grok-4' }] })
    const backend = getVoiceBackend('xai')
    expect((await backend.listModels(context, 'stt')).map(m => m.id)).toEqual(['grok-voice-transcribe-2.0', 'grok-voice-transcribe-1.0'])
    expect((await backend.listModels(context, 'tts')).map(m => m.id)).toEqual(['grok-voice-tts-1.0'])
  })
})

describe('transcription usage', () => {
  const request = { audio: Buffer.from('audio'), modelId: 'm', filename: 'a.ogg' }

  it('returns the seconds and cost OpenRouter reports', async () => {
    const { context } = ctx('https://openrouter.ai/api/v1', { text: ' Hi ', usage: { seconds: 9.2, cost: 0.0005 } })
    expect(await getVoiceBackend('openrouter').transcribe(context, request)).toEqual({ text: 'Hi', durationSeconds: 9.2, costUsd: 0.0005 })
  })

  it('reads the Mistral audio seconds and verbose durations', async () => {
    const mistral = ctx('https://api.mistral.ai', { text: 'Hi', usage: { prompt_audio_seconds: 4 } })
    expect(await getVoiceBackend('mistral').transcribe(mistral.context, request)).toEqual({ text: 'Hi', durationSeconds: 4 })
    const verbose = ctx('https://api.openai.com/v1', { text: 'Hi', duration: 12.5 })
    expect(await getVoiceBackend('openai').transcribe(verbose.context, request)).toEqual({ text: 'Hi', durationSeconds: 12.5 })
  })

  it('returns only the text when the provider reports no usage', async () => {
    const { context } = ctx('https://api.x.ai/v1', { text: 'Hi', usage: { type: 'tokens', input_tokens: 10 } })
    expect(await getVoiceBackend('xai').transcribe(context, request)).toEqual({ text: 'Hi' })
  })

  it('returns the Deepgram metadata duration', async () => {
    const { context } = ctx('https://api.deepgram.com', {
      metadata: { duration: 3.5 },
      results: { channels: [{ alternatives: [{ transcript: 'Hallo' }] }] },
    })
    expect(await getVoiceBackend('deepgram').transcribe(context, request)).toEqual({ text: 'Hallo', durationSeconds: 3.5 })
  })
})
