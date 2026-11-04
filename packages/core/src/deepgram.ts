/**
 * Deepgram voice integration — Speech-to-Text (pre-recorded audio) and
 * Text-to-Speech.
 *
 * STT API:  POST https://api.deepgram.com/v1/listen
 *   - Auth: `Authorization: Token <key>`
 *   - Body: raw audio bytes
 *   - Query: `model`, `language`, `punctuate`, `smart_format`
 *
 * TTS API:  POST https://api.deepgram.com/v1/speak
 *   - Auth: `Authorization: Token <key>`
 *   - Content-Type: application/json
 *   - Query: `model`, `encoding`, `container`
 *   - Body: { "text": "..." }
 *   - Response: raw audio bytes
 */


// ── Constants ─────────────────────────────────────────────────────────

export const DEEPGRAM_DEFAULT_BASE_URL = 'https://api.deepgram.com'

/** Audio container Deepgram should encode the synthesized speech in. */
export type DeepgramTtsEncoding = 'mp3' | 'linear16' | 'opus' | 'flac'

// ── Types ─────────────────────────────────────────────────────────────

export interface DeepgramTranscribeOptions {
  /** Override base URL (mainly for tests / proxies). */
  baseUrl?: string
  fetchImpl?: typeof fetch
  signal?: AbortSignal
  /** Model name, e.g. `nova-3`, `nova-2-general`, `enhanced`. */
  model: string
  /** ISO-639-1 language code (`en`, `de`, ...) or `multi`. Omit for auto-detect. */
  language?: string
  /** Hint used to set Content-Type when the format is not auto-detected. */
  mimeType?: string
}

export interface DeepgramSynthesizeOptions {
  /** Override base URL (mainly for tests / proxies). */
  baseUrl?: string
  fetchImpl?: typeof fetch
  signal?: AbortSignal
  /** Voice / model name, e.g. `aura-2-thalia-en`. */
  model: string
  encoding: DeepgramTtsEncoding
}

/** One entry of Deepgram's `GET /v1/models` response (extra metadata keys are kept loose). */
export interface DeepgramModel {
  name: string
  /** API identifier passed to `?model=`, e.g. `nova-3-general`, `aura-2-thalia-en`. */
  canonical_name: string
  architecture: string
  languages: string[]
  version: string
  uuid: string
  batch?: boolean
  streaming?: boolean
  metadata?: {
    accent?: string
    tags?: string[]
    use_cases?: string[]
    [key: string]: unknown
  }
}

export interface DeepgramModelsList {
  stt: DeepgramModel[]
  tts: DeepgramModel[]
}

export interface DeepgramListModelsOptions {
  /** Override base URL (mainly for tests / proxies). */
  baseUrl?: string
  fetchImpl?: typeof fetch
  signal?: AbortSignal
}

// ── Error mapping ─────────────────────────────────────────────────────

/**
 * Map a Deepgram non-OK response to a human-readable error message that
 * makes the failure mode (auth / rate limit / server) easy to spot in
 * logs and Telegram error replies.
 */
async function describeDeepgramError(label: string, response: Response): Promise<Error> {
  const body = await response.text().catch(() => '')
  const trimmed = body.trim().slice(0, 500)
  if (response.status === 401 || response.status === 403) {
    return new Error(`${label} authentication failed (HTTP ${response.status}): invalid or missing Deepgram API key.`)
  }
  if (response.status === 429) {
    return new Error(`${label} rate-limited by Deepgram (HTTP 429). ${trimmed}`.trim())
  }
  if (response.status >= 500) {
    return new Error(`${label} upstream error (HTTP ${response.status}). ${trimmed}`.trim())
  }
  return new Error(`${label} returned HTTP ${response.status}. ${trimmed}`.trim())
}

// ── Models listing ─────────────────────────────────────────────────────

/**
 * Fetch the list of available Deepgram models via `GET /v1/models`.
 *
 * Returns a `{ stt, tts }` object that mirrors Deepgram's response shape.
 * Empty arrays (rather than `null`) are returned when one of the categories
 * is missing in the API response, so the UI can iterate without null checks.
 */
export async function listDeepgramModels(
  apiKey: string,
  options: DeepgramListModelsOptions = {},
): Promise<DeepgramModelsList> {
  if (!apiKey) {
    throw new Error('Deepgram models: API key is not configured.')
  }

  const base = (options.baseUrl ?? DEEPGRAM_DEFAULT_BASE_URL).replace(/\/+$/, '')
  const url = `${base}/v1/models`

  let response: Response
  try {
    response = await (options.fetchImpl ?? fetch)(url, {
      signal: options.signal,
      method: 'GET',
      headers: {
        Authorization: `Token ${apiKey}`,
        Accept: 'application/json',
      },
    })
  } catch (err) {
    throw new Error(`Deepgram models request failed: ${(err as Error).message}`)
  }

  if (!response.ok) {
    throw await describeDeepgramError('Deepgram models', response)
  }

  let data: unknown
  try {
    data = await response.json()
  } catch (err) {
    throw new Error(`Deepgram models: invalid JSON response: ${(err as Error).message}`)
  }

  // Be lenient with the payload shape: pull `stt`/`tts` if they're arrays,
  // default to empty otherwise. Real upstream errors come through the
  // non-OK branch above; a body that parses but lacks the expected keys
  // shouldn't crash the picker UI.
  const stt = data && typeof data === 'object' && Array.isArray((data as { stt?: unknown }).stt)
    ? (data as { stt: DeepgramModel[] }).stt
    : []
  const tts = data && typeof data === 'object' && Array.isArray((data as { tts?: unknown }).tts)
    ? (data as { tts: DeepgramModel[] }).tts
    : []
  return { stt, tts }
}

// ── STT ────────────────────────────────────────────────────────────

export interface DeepgramTranscription {
  transcript: string
  /** `metadata.duration` of the response: the audio length Deepgram bills. */
  durationSeconds?: number
}

/**
 * Transcribe pre-recorded audio via Deepgram's `/v1/listen` endpoint.
 *
 * Deepgram detects the container automatically. We still send the caller's
 * MIME hint (default `audio/ogg`) as `Content-Type` so misconfigured proxies
 * don't strip the body.
 */
export async function transcribeDeepgram(
  buffer: Buffer,
  apiKey: string,
  options: DeepgramTranscribeOptions,
): Promise<DeepgramTranscription> {
  if (!apiKey) {
    throw new Error('Deepgram STT: API key is not configured. Add it to the Deepgram provider.')
  }
  if (!buffer || buffer.length === 0) {
    throw new Error('Deepgram STT: audio buffer is empty.')
  }

  const base = (options.baseUrl ?? DEEPGRAM_DEFAULT_BASE_URL).replace(/\/+$/, '')
  const params = new URLSearchParams()
  params.set('model', options.model)
  params.set('punctuate', 'true')
  params.set('smart_format', 'true')
  if (options.language) {
    params.set('language', options.language)
  }
  const url = `${base}/v1/listen?${params.toString()}`

  let response: Response
  try {
    response = await (options.fetchImpl ?? fetch)(url, {
      signal: options.signal,
      method: 'POST',
      headers: {
        Authorization: `Token ${apiKey}`,
        'Content-Type': options.mimeType || 'audio/ogg',
      },
      // Buffer is a Uint8Array subclass and is accepted by Node's undici-based
      // fetch as a body. Cast through `unknown` so we don't depend on DOM lib's
      // `BodyInit` (not part of the core build's @types).
      body: buffer as unknown as ReadableStream<Uint8Array>,
    })
  } catch (err) {
    throw new Error(`Deepgram STT request failed: ${(err as Error).message}`)
  }

  if (!response.ok) {
    throw await describeDeepgramError('Deepgram STT', response)
  }

  let data: unknown
  try {
    data = await response.json()
  } catch (err) {
    throw new Error(`Deepgram STT: invalid JSON response: ${(err as Error).message}`)
  }

  const transcript = extractDeepgramTranscript(data)
  if (transcript === null) {
    throw new Error('Deepgram STT: response did not contain a transcript.')
  }
  const duration = (data as { metadata?: { duration?: unknown } }).metadata?.duration
  return {
    transcript: transcript.trim(),
    ...(typeof duration === 'number' && Number.isFinite(duration) && duration > 0 && { durationSeconds: duration }),
  }
}

/**
 * Pull the first alternative's transcript out of Deepgram's nested response
 * shape: `{ results: { channels: [ { alternatives: [ { transcript } ] } ] } }`.
 * Returns `null` (not the empty string) when the structure is missing so
 * callers can distinguish "API responded with empty transcript" from "API
 * returned an unexpected shape" — only the latter is an error.
 */
function extractDeepgramTranscript(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  const results = (payload as { results?: unknown }).results
  if (!results || typeof results !== 'object') return null
  const channels = (results as { channels?: unknown }).channels
  if (!Array.isArray(channels) || channels.length === 0) return null
  const first = channels[0]
  if (!first || typeof first !== 'object') return null
  const alternatives = (first as { alternatives?: unknown }).alternatives
  if (!Array.isArray(alternatives) || alternatives.length === 0) return null
  const alt = alternatives[0]
  if (!alt || typeof alt !== 'object') return null
  const transcript = (alt as { transcript?: unknown }).transcript
  return typeof transcript === 'string' ? transcript : null
}

// ── TTS ───────────────────────────────────────────────────────────────

/**
 * Synthesize speech via Deepgram's `/v1/speak` endpoint.
 *
 * Returns the raw audio bytes (e.g. an MP3) the caller can stream to a
 * client or upload to Telegram as a voice message.
 */
export async function synthesizeDeepgram(
  text: string,
  apiKey: string,
  options: DeepgramSynthesizeOptions,
): Promise<Buffer> {
  if (!apiKey) {
    throw new Error('Deepgram TTS: API key is not configured. Add it to the Deepgram provider.')
  }
  const trimmed = text?.trim() ?? ''
  if (!trimmed) {
    throw new Error('Deepgram TTS: input text is empty.')
  }
  const base = (options.baseUrl ?? DEEPGRAM_DEFAULT_BASE_URL).replace(/\/+$/, '')
  const params = new URLSearchParams()
  params.set('model', options.model)
  params.set('encoding', options.encoding)
  // REST linear16 defaults to a WAV container; callers concatenate chunks and add a single header.
  if (options.encoding === 'linear16') params.set('container', 'none')
  const url = `${base}/v1/speak?${params.toString()}`

  let response: Response
  try {
    response = await (options.fetchImpl ?? fetch)(url, {
      signal: options.signal,
      method: 'POST',
      headers: {
        Authorization: `Token ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text: trimmed }),
    })
  } catch (err) {
    throw new Error(`Deepgram TTS request failed: ${(err as Error).message}`)
  }

  if (!response.ok) {
    throw await describeDeepgramError('Deepgram TTS', response)
  }

  const arrayBuffer = await response.arrayBuffer()
  return Buffer.from(arrayBuffer)
}
