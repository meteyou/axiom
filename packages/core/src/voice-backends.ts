/**
 * Provider-specific STT/TTS wire protocols. Each backend lists the provider's
 * voice models live, transcribes audio and synthesizes speech; `stt.ts` and
 * `tts.ts` resolve the configured `providerId:modelId` and dispatch here.
 */

import type { AvailableVoiceModelContract, VoiceOptionContract } from './contracts/providers.js'
import type { TtsResponseFormat } from './contracts/settings.js'
import { DEEPGRAM_DEFAULT_BASE_URL, listDeepgramModels, synthesizeDeepgram, transcribeDeepgram } from './deepgram.js'
import type { DeepgramModel, DeepgramTtsEncoding } from './deepgram.js'
import type { VoiceBackendId, VoiceModelKind } from './voice-capabilities.js'

export type AvailableVoiceModel = AvailableVoiceModelContract
export type VoiceOption = VoiceOptionContract

export interface VoiceRequestContext {
  baseUrl: string
  apiKey: string
  fetchImpl?: typeof fetch
  signal?: AbortSignal
}

export interface VoiceTranscribeRequest {
  audio: Buffer
  modelId: string
  /** ISO-639-1 code; omitted for auto-detection. */
  language?: string
  /** Original filename hint (e.g. `audio.ogg`), used to derive the audio format. */
  filename?: string
}

export interface VoiceSynthesizeRequest {
  text: string
  modelId: string
  voice?: string
  instructions?: string
  format: TtsResponseFormat
}

export interface SynthesizedAudio {
  audio: Buffer
  /** MIME type matching the encoded audio (e.g. `audio/mpeg`). */
  contentType: string
  /** File extension hint without leading dot (e.g. `mp3`, `ogg`). */
  extension: string
}

interface VoiceBackend {
  listModels: (ctx: VoiceRequestContext, kind: VoiceModelKind) => Promise<AvailableVoiceModel[]>
  /** Omitted when the model id already is the voice (Deepgram Aura). */
  listVoices?: (ctx: VoiceRequestContext, modelId: string) => Promise<VoiceOption[]>
  transcribe: (ctx: VoiceRequestContext, request: VoiceTranscribeRequest) => Promise<string>
  synthesize: (ctx: VoiceRequestContext, request: VoiceSynthesizeRequest) => Promise<SynthesizedAudio>
}

// ── Shared helpers ────────────────────────────────────────────────────

/** Base URL ending in a version segment (`…/v1`), so paths can be appended directly. */
export function voiceApiRoot(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  return /\/v\d+(beta)?$/.test(trimmed) ? trimmed : `${trimmed}/v1`
}

function fetchOf(ctx: VoiceRequestContext): typeof fetch {
  return ctx.fetchImpl ?? fetch
}

function bearer(ctx: VoiceRequestContext): Record<string, string> {
  return ctx.apiKey ? { Authorization: `Bearer ${ctx.apiKey}` } : {}
}

async function requestOk(label: string, ctx: VoiceRequestContext, url: string, init: RequestInit = {}): Promise<Response> {
  let response: Response
  try {
    response = await fetchOf(ctx)(url, { ...init, signal: ctx.signal })
  } catch (err) {
    throw new Error(`${label} request failed: ${(err as Error).message}`)
  }
  if (!response.ok) {
    const body = (await response.text().catch(() => '')).trim().slice(0, 500)
    if (response.status === 401 || response.status === 403) {
      throw new Error(`${label} authentication failed (HTTP ${response.status}). ${body}`.trim())
    }
    throw new Error(`${label} returned HTTP ${response.status}. ${body}`.trim())
  }
  return response
}

async function readTranscript(label: string, response: Response): Promise<string> {
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) return (await response.text()).trim()
  const data = await response.json() as { text?: unknown }
  if (typeof data.text !== 'string') throw new Error(`${label}: response did not contain a transcript.`)
  return data.text.trim()
}

const AUDIO_DESCRIPTIONS: Record<string, { contentType: string; extension: string }> = {
  mp3: { contentType: 'audio/mpeg', extension: 'mp3' },
  wav: { contentType: 'audio/wav', extension: 'wav' },
  opus: { contentType: 'audio/ogg', extension: 'ogg' },
  flac: { contentType: 'audio/flac', extension: 'flac' },
}

function describeAudio(format: TtsResponseFormat): { contentType: string; extension: string } {
  return AUDIO_DESCRIPTIONS[format] ?? AUDIO_DESCRIPTIONS.mp3!
}

const AUDIO_FORMAT_BY_EXTENSION: Record<string, string> = {
  oga: 'ogg',
  ogg: 'ogg',
  opus: 'ogg',
  webm: 'webm',
  mp3: 'mp3',
  mpga: 'mp3',
  mpeg: 'mp3',
  wav: 'wav',
  m4a: 'm4a',
  mp4: 'm4a',
  aac: 'aac',
  flac: 'flac',
}

/** Audio container derived from a filename (`audio.ogg` → `ogg`); WebM is what browsers record. */
export function audioFormatFromFilename(filename: string | undefined): string {
  const extension = filename?.split('.').pop()?.toLowerCase() ?? ''
  return AUDIO_FORMAT_BY_EXTENSION[extension] ?? 'webm'
}

const AUDIO_MIME_BY_FORMAT: Record<string, string> = {
  ogg: 'audio/ogg',
  webm: 'audio/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
}

function multipartAudio(request: VoiceTranscribeRequest): Blob {
  const mime = AUDIO_MIME_BY_FORMAT[audioFormatFromFilename(request.filename)] ?? 'application/octet-stream'
  return new Blob([new Uint8Array(request.audio)], { type: mime })
}

function sortById<T extends { id: string }>(models: T[]): T[] {
  return [...models].sort((a, b) => a.id.localeCompare(b.id))
}

// ── OpenAI / OpenAI-compatible ────────────────────────────────────────

const OPENAI_VOICES: ReadonlyArray<VoiceOption & { classic: boolean }> = [
  { id: 'alloy', name: 'Alloy', classic: true },
  { id: 'ash', name: 'Ash', classic: true },
  { id: 'ballad', name: 'Ballad', classic: false },
  { id: 'coral', name: 'Coral', classic: true },
  { id: 'echo', name: 'Echo', classic: true },
  { id: 'fable', name: 'Fable', classic: true },
  { id: 'nova', name: 'Nova', classic: true },
  { id: 'onyx', name: 'Onyx', classic: true },
  { id: 'sage', name: 'Sage', classic: true },
  { id: 'shimmer', name: 'Shimmer', classic: true },
  { id: 'verse', name: 'Verse', classic: false },
  { id: 'marin', name: 'Marin', classic: false },
  { id: 'cedar', name: 'Cedar', classic: false },
]

function isClassicOpenAiTtsModel(modelId: string): boolean {
  return /^tts-1/.test(modelId)
}

/** Only the `gpt-4o*-tts` family honors `instructions`; other OpenAI models reject the field. */
function supportsOpenAiInstructions(modelId: string): boolean {
  return /gpt-.*tts/.test(modelId)
}

/** OpenAI's `/models` carries no modality metadata, so voice models are recognized by id. */
function isOpenAiVoiceModelId(modelId: string, kind: VoiceModelKind): boolean {
  if (/realtime/.test(modelId)) return false
  return kind === 'stt' ? /whisper|transcribe/.test(modelId) : /tts/.test(modelId)
}

async function listOpenAiModelIds(ctx: VoiceRequestContext, label: string): Promise<string[]> {
  const response = await requestOk(label, ctx, `${voiceApiRoot(ctx.baseUrl)}/models`, { headers: bearer(ctx) })
  const data = await response.json() as { data?: Array<{ id?: unknown }> }
  return (data.data ?? []).map(entry => entry.id).filter((id): id is string => typeof id === 'string')
}

async function transcribeOpenAiCompatible(label: string, ctx: VoiceRequestContext, request: VoiceTranscribeRequest): Promise<string> {
  const form = new FormData()
  form.append('model', request.modelId)
  if (request.language) form.append('language', request.language)
  form.append('file', multipartAudio(request), request.filename ?? 'audio.webm')
  const response = await requestOk(label, ctx, `${voiceApiRoot(ctx.baseUrl)}/audio/transcriptions`, {
    method: 'POST',
    headers: bearer(ctx),
    body: form,
  })
  return readTranscript(label, response)
}

async function synthesizeOpenAiCompatible(
  label: string,
  ctx: VoiceRequestContext,
  request: VoiceSynthesizeRequest,
  defaultVoice: string | undefined,
): Promise<SynthesizedAudio> {
  const body: Record<string, unknown> = {
    model: request.modelId,
    input: request.text,
    response_format: request.format,
  }
  const voice = request.voice || defaultVoice
  if (voice) body.voice = voice
  if (request.instructions && supportsOpenAiInstructions(request.modelId)) body.instructions = request.instructions
  const response = await requestOk(label, ctx, `${voiceApiRoot(ctx.baseUrl)}/audio/speech`, {
    method: 'POST',
    headers: { ...bearer(ctx), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { audio: Buffer.from(await response.arrayBuffer()), ...describeAudio(request.format) }
}

const openAiBackend: VoiceBackend = {
  async listModels(ctx, kind) {
    const ids = await listOpenAiModelIds(ctx, 'OpenAI models')
    return sortById(ids.filter(id => isOpenAiVoiceModelId(id, kind)).map(id => ({ id, name: id })))
  },
  async listVoices(_ctx, modelId) {
    const classicOnly = isClassicOpenAiTtsModel(modelId)
    return OPENAI_VOICES.filter(voice => !classicOnly || voice.classic).map(({ id, name }) => ({ id, name }))
  },
  transcribe: (ctx, request) => transcribeOpenAiCompatible('OpenAI STT', ctx, request),
  synthesize: (ctx, request) => synthesizeOpenAiCompatible('OpenAI TTS', ctx, request, 'alloy'),
}

/** Self-hosted OpenAI-compatible servers name their models freely, so the whole list is offered. */
const openAiCompatibleBackend: VoiceBackend = {
  async listModels(ctx) {
    const ids = await listOpenAiModelIds(ctx, 'Models')
    return sortById(ids.map(id => ({ id, name: id })))
  },
  transcribe: (ctx, request) => transcribeOpenAiCompatible('STT', ctx, request),
  synthesize: (ctx, request) => synthesizeOpenAiCompatible('TTS', ctx, request, undefined),
}

// ── Mistral ───────────────────────────────────────────────────────────

interface MistralModelEntry {
  id?: string
  name?: string | null
  description?: string | null
  capabilities?: { audio_transcription?: boolean; audio_speech?: boolean }
}

const mistralBackend: VoiceBackend = {
  async listModels(ctx, kind) {
    const response = await requestOk('Mistral models', ctx, `${voiceApiRoot(ctx.baseUrl)}/models`, { headers: bearer(ctx) })
    const data = await response.json() as { data?: MistralModelEntry[] }
    const capability = kind === 'stt' ? 'audio_transcription' : 'audio_speech'
    const seen = new Set<string>()
    const models: AvailableVoiceModel[] = []
    for (const entry of data.data ?? []) {
      if (!entry.id || !entry.capabilities?.[capability] || seen.has(entry.id)) continue
      seen.add(entry.id)
      models.push({
        id: entry.id,
        name: entry.name || entry.id,
        ...(entry.description && { description: entry.description }),
      })
    }
    return sortById(models)
  },
  async listVoices(ctx) {
    const response = await requestOk('Mistral voices', ctx, `${voiceApiRoot(ctx.baseUrl)}/audio/voices?limit=100`, { headers: bearer(ctx) })
    const data = await response.json() as { items?: Array<{ id: string; name: string; languages?: string[] }> }
    return (data.items ?? []).map(voice => ({
      id: voice.id,
      name: voice.name,
      ...(voice.languages?.[0] && { language: voice.languages[0] }),
    }))
  },
  transcribe: (ctx, request) => transcribeOpenAiCompatible('Mistral STT', ctx, request),
  async synthesize(ctx, request) {
    const body: Record<string, unknown> = {
      model: request.modelId,
      input: request.text,
      response_format: request.format,
      stream: false,
    }
    if (request.voice) body.voice_id = request.voice
    const response = await requestOk('Mistral TTS', ctx, `${voiceApiRoot(ctx.baseUrl)}/audio/speech`, {
      method: 'POST',
      headers: { ...bearer(ctx), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    // Mistral answers with raw audio or a `{ audio_data: base64 }` envelope depending on the API version.
    if ((response.headers.get('content-type') ?? '').includes('application/json')) {
      const data = await response.json() as { audio_data?: string }
      if (!data.audio_data) throw new Error('Mistral TTS returned no audio data.')
      return { audio: Buffer.from(data.audio_data, 'base64'), ...describeAudio(request.format) }
    }
    return { audio: Buffer.from(await response.arrayBuffer()), ...describeAudio(request.format) }
  },
}

// ── OpenRouter ────────────────────────────────────────────────────────

interface OpenRouterVoiceModelEntry {
  id: string
  name?: string
  description?: string
  pricing?: { prompt?: string; completion?: string }
  supported_voices?: string[]
}

const OPENROUTER_LIST_TTL_MS = 10 * 60_000
const openRouterListCache = new Map<string, { fetchedAt: number; models: OpenRouterVoiceModelEntry[] }>()

async function listOpenRouterVoiceModels(ctx: VoiceRequestContext, kind: VoiceModelKind): Promise<OpenRouterVoiceModelEntry[]> {
  const modality = kind === 'stt' ? 'transcription' : 'speech'
  const url = `${voiceApiRoot(ctx.baseUrl)}/models?output_modalities=${modality}`
  const cached = openRouterListCache.get(url)
  if (cached && Date.now() - cached.fetchedAt < OPENROUTER_LIST_TTL_MS) return cached.models
  const response = await requestOk('OpenRouter models', ctx, url, { headers: bearer(ctx) })
  const data = await response.json() as { data?: OpenRouterVoiceModelEntry[] }
  const models = (data.data ?? []).filter(entry => typeof entry.id === 'string')
  openRouterListCache.set(url, { fetchedAt: Date.now(), models })
  return models
}

/** OpenRouter prices TTS per input character and STT per audio second. */
function openRouterCostPerMillion(entry: OpenRouterVoiceModelEntry): number | undefined {
  const prompt = Number(entry.pricing?.prompt)
  const completion = Number(entry.pricing?.completion)
  if (!Number.isFinite(prompt) || prompt <= 0 || (Number.isFinite(completion) && completion > 0)) return undefined
  return Math.round(prompt * 1_000_000 * 1e6) / 1e6
}

async function openRouterVoices(ctx: VoiceRequestContext, modelId: string): Promise<string[]> {
  const models = await listOpenRouterVoiceModels(ctx, 'tts')
  return models.find(entry => entry.id === modelId)?.supported_voices ?? []
}

const openRouterBackend: VoiceBackend = {
  async listModels(ctx, kind) {
    const models = await listOpenRouterVoiceModels(ctx, kind)
    return sortById(models.map((entry) => {
      const costPerMillion = openRouterCostPerMillion(entry)
      return {
        id: entry.id,
        name: entry.name || entry.id,
        ...(costPerMillion !== undefined && { costPerMillion }),
      }
    }))
  },
  async listVoices(ctx, modelId) {
    return (await openRouterVoices(ctx, modelId)).map(id => ({ id, name: id }))
  },
  async transcribe(ctx, request) {
    const body: Record<string, unknown> = {
      model: request.modelId,
      input_audio: { data: request.audio.toString('base64'), format: audioFormatFromFilename(request.filename) },
    }
    if (request.language) body.language = request.language
    const response = await requestOk('OpenRouter STT', ctx, `${voiceApiRoot(ctx.baseUrl)}/audio/transcriptions`, {
      method: 'POST',
      headers: { ...bearer(ctx), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return readTranscript('OpenRouter STT', response)
  },
  async synthesize(ctx, request) {
    // OpenRouter only returns `mp3` or headerless `pcm`; every other format falls back to MP3.
    const voice = request.voice || (await openRouterVoices(ctx, request.modelId).catch(() => []))[0]
    const body: Record<string, unknown> = { model: request.modelId, input: request.text, response_format: 'mp3' }
    if (voice) body.voice = voice
    if (request.instructions) body.instructions = request.instructions
    const response = await requestOk('OpenRouter TTS', ctx, `${voiceApiRoot(ctx.baseUrl)}/audio/speech`, {
      method: 'POST',
      headers: { ...bearer(ctx), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { audio: Buffer.from(await response.arrayBuffer()), ...describeAudio('mp3') }
  },
}

// ── xAI ───────────────────────────────────────────────────────────────

const XAI_STT_FALLBACK_MODELS = ['grok-voice-transcribe-2.0', 'grok-voice-transcribe-1.0']
/** xAI's `/v1/tts` takes no model parameter; this id only represents the service in the model lists. */
const XAI_TTS_MODEL_ID = 'grok-voice-tts-1.0'

const xaiBackend: VoiceBackend = {
  async listModels(ctx, kind) {
    if (kind === 'tts') return [{ id: XAI_TTS_MODEL_ID, name: 'Grok Voice TTS' }]
    // xAI documents no listing for voice models; prefer the live list when it includes them.
    const ids = await listOpenAiModelIds(ctx, 'xAI models').catch(() => [] as string[])
    const live = ids.filter(id => /transcribe|stt/.test(id))
    return (live.length > 0 ? live : XAI_STT_FALLBACK_MODELS).map(id => ({ id, name: id }))
  },
  async listVoices(ctx) {
    const response = await requestOk('xAI voices', ctx, `${voiceApiRoot(ctx.baseUrl)}/tts/voices`, { headers: bearer(ctx) })
    const data = await response.json() as { voices?: Array<{ voice_id: string; name?: string; language?: string | null }> }
    return (data.voices ?? []).map(voice => ({
      id: voice.voice_id,
      name: voice.name || voice.voice_id,
      ...(voice.language && { language: voice.language }),
    }))
  },
  async transcribe(ctx, request) {
    const form = new FormData()
    form.append('model', request.modelId)
    if (request.language) form.append('language', request.language)
    // xAI ignores fields sent after `file`, so it must come last.
    form.append('file', multipartAudio(request), request.filename ?? 'audio.webm')
    const response = await requestOk('xAI STT', ctx, `${voiceApiRoot(ctx.baseUrl)}/stt`, {
      method: 'POST',
      headers: bearer(ctx),
      body: form,
    })
    return readTranscript('xAI STT', response)
  },
  async synthesize(ctx, request) {
    const format: TtsResponseFormat = request.format === 'wav' ? 'wav' : 'mp3'
    const body: Record<string, unknown> = {
      text: request.text,
      language: 'auto',
      output_format: { codec: format },
    }
    if (request.voice) body.voice_id = request.voice
    const response = await requestOk('xAI TTS', ctx, `${voiceApiRoot(ctx.baseUrl)}/tts`, {
      method: 'POST',
      headers: { ...bearer(ctx), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { audio: Buffer.from(await response.arrayBuffer()), ...describeAudio(format) }
  },
}

// ── Deepgram ──────────────────────────────────────────────────────────

const DEEPGRAM_FORMAT_MAP: Record<TtsResponseFormat, DeepgramTtsEncoding> = {
  mp3: 'mp3',
  opus: 'opus',
  flac: 'flac',
  wav: 'linear16',
}

const DEEPGRAM_LINEAR16_SAMPLE_RATE = 24000

/** Kept under Deepgram's 2000-char `/v1/speak` limit to leave headroom at chunk joins. */
const DEEPGRAM_TTS_CHUNK_LIMIT = 1900
const DEEPGRAM_TTS_HARD_LIMIT = 2000

/**
 * Split `text` into chunks of at most `maxLen` characters, preferring
 * sentence → word boundaries so the synthesized prosody stays smooth.
 */
function chunkTextForDeepgram(text: string, maxLen = DEEPGRAM_TTS_CHUNK_LIMIT): string[] {
  const trimmed = text.trim()
  if (trimmed.length <= maxLen) return [trimmed]

  const pieces = trimmed.split(/(?<=[.!?\n])\s+/)
  const chunks: string[] = []
  let current = ''
  const flush = () => {
    if (current.trim()) chunks.push(current.trim())
    current = ''
  }

  for (const piece of pieces) {
    if (piece.length > maxLen) {
      flush()
      let remaining = piece
      while (remaining.length > maxLen) {
        const slice = remaining.slice(0, maxLen)
        const lastSpace = slice.lastIndexOf(' ')
        const cut = lastSpace > maxLen * 0.5 ? lastSpace : maxLen
        chunks.push(slice.slice(0, cut).trim())
        remaining = remaining.slice(cut).trim()
      }
      if (remaining) current = remaining
      continue
    }
    if (current.length + piece.length + 1 > maxLen) flush()
    current = current ? `${current} ${piece}` : piece
  }
  flush()
  return chunks
}

/** Wrap headerless 16-bit mono PCM in a canonical 44-byte WAV header. */
function wrapPcmInWav(pcm: Buffer, sampleRate: number, channels = 1, bitsPerSample = 16): Buffer {
  const blockAlign = (channels * bitsPerSample) / 8
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * blockAlign, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bitsPerSample, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

function deepgramBase(ctx: VoiceRequestContext): string {
  return (ctx.baseUrl || DEEPGRAM_DEFAULT_BASE_URL).replace(/\/+$/, '').replace(/\/v1$/, '')
}

/** Deepgram lists one entry per language/version; collapse them per `canonical_name`. */
function collapseDeepgramModels(entries: DeepgramModel[]): AvailableVoiceModel[] {
  const byId = new Map<string, AvailableVoiceModel & { languages: string[] }>()
  for (const entry of entries) {
    if (!entry.canonical_name) continue
    let model = byId.get(entry.canonical_name)
    if (!model) {
      model = { id: entry.canonical_name, name: entry.canonical_name, languages: [] }
      const accent = typeof entry.metadata?.accent === 'string' ? entry.metadata.accent : ''
      if (accent) model.description = accent
      byId.set(entry.canonical_name, model)
    }
    for (const language of entry.languages ?? []) {
      if (language && !model.languages.includes(language)) model.languages.push(language)
    }
  }
  return sortById([...byId.values()])
}

const deepgramBackend: VoiceBackend = {
  async listModels(ctx, kind) {
    const models = await listDeepgramModels(ctx.apiKey, { baseUrl: deepgramBase(ctx), fetchImpl: ctx.fetchImpl, signal: ctx.signal })
    return collapseDeepgramModels(kind === 'stt' ? models.stt : models.tts)
  },
  transcribe(ctx, request) {
    return transcribeDeepgram(request.audio, ctx.apiKey, {
      baseUrl: deepgramBase(ctx),
      fetchImpl: ctx.fetchImpl,
      signal: ctx.signal,
      model: request.modelId,
      language: request.language,
      mimeType: AUDIO_MIME_BY_FORMAT[audioFormatFromFilename(request.filename)],
    })
  },
  async synthesize(ctx, request) {
    const encoding = DEEPGRAM_FORMAT_MAP[request.format]
    // MP3 frames and raw PCM survive naive concatenation; Opus/FLAC containers do not.
    const concatenationSafe = encoding === 'mp3' || encoding === 'linear16'
    if (request.text.length > DEEPGRAM_TTS_HARD_LIMIT && !concatenationSafe) {
      throw new Error(
        `Deepgram TTS: text is ${request.text.length} chars (>${DEEPGRAM_TTS_HARD_LIMIT}). Long texts need the MP3 or WAV response format.`,
      )
    }
    const chunks = concatenationSafe ? chunkTextForDeepgram(request.text) : [request.text.trim()]
    const parts: Buffer[] = []
    for (const chunk of chunks) {
      parts.push(await synthesizeDeepgram(chunk, ctx.apiKey, {
        baseUrl: deepgramBase(ctx),
        fetchImpl: ctx.fetchImpl,
        signal: ctx.signal,
        model: request.modelId,
        encoding,
      }))
    }
    const raw = parts.length === 1 ? parts[0]! : Buffer.concat(parts)
    if (request.format === 'wav') {
      return { audio: wrapPcmInWav(raw, DEEPGRAM_LINEAR16_SAMPLE_RATE), contentType: 'audio/wav', extension: 'wav' }
    }
    return { audio: raw, ...describeAudio(request.format) }
  },
}

const VOICE_BACKENDS: Record<VoiceBackendId, VoiceBackend> = {
  openai: openAiBackend,
  'openai-compatible': openAiCompatibleBackend,
  mistral: mistralBackend,
  openrouter: openRouterBackend,
  xai: xaiBackend,
  deepgram: deepgramBackend,
}

export function getVoiceBackend(id: VoiceBackendId): VoiceBackend {
  return VOICE_BACKENDS[id]
}

export function clearVoiceModelListCache(): void {
  openRouterListCache.clear()
}
