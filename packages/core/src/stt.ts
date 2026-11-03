import { loadConfig, ensureConfigTemplates } from './config.js'
import { loadProvidersDecrypted, getApiKeyForProvider, buildModel, parseProviderModelId, getProviderDefaultModel, isProviderModelUsable } from './provider-config.js'
import { normalizeSttSettings } from './contracts/settings.js'
import type { SttSettingsContract } from './contracts/settings.js'
import { completeSimple } from './pi-models.js'
import { resolveVoiceModelRef, transcribeWithProvider } from './voice-models.js'

// ── Types ─────────────────────────────────────────────────────────────

export type SttSettings = SttSettingsContract
export type SttRewriteSettings = SttSettingsContract['rewrite']

export interface TranscribeResult {
  transcript: string
  rewritten?: string
}

export interface TranscribeOptions {
  language?: string
  /** Original filename hint (e.g. 'audio.ogg'). Helps APIs detect the format. */
  filename?: string
}

// ── Load settings ─────────────────────────────────────────────────────

export function loadSttSettings(): SttSettings {
  ensureConfigTemplates()
  const settings = loadConfig<Record<string, unknown>>('settings.json')
  return normalizeSttSettings(settings.stt as Partial<SttSettings> | undefined)
}

// ── Rewrite ───────────────────────────────────────────────────────────

const REWRITE_SYSTEM_PROMPT = [
  'You are a transcript editor. Clean up the following dictated text.',
  '- Remove filler words (um, uh, like, you know, basically, well, so, etc.)',
  '- Remove false starts and repeated words or phrases',
  '- Fix grammar and punctuation',
  '- Preserve the complete meaning, intent, and tone',
  '- Do NOT add, summarize, or reinterpret the content',
  '- Output ONLY the cleaned text, nothing else',
].join('\n')

export async function rewriteTranscript(
  transcript: string,
  rawProviderId: string,
): Promise<string> {
  const { providerId, modelId } = parseProviderModelId(rawProviderId)
  const provider = loadProvidersDecrypted().providers.find(p => p.id === providerId)
  if (!provider) {
    throw new Error(`Rewrite provider not found: ${providerId}. Check Settings → Speech-to-Text.`)
  }
  if (!isProviderModelUsable(provider, modelId)) {
    throw new Error(`Rewrite model is disabled: ${rawProviderId}. Check Settings → Speech-to-Text.`)
  }

  const apiKey = await getApiKeyForProvider(provider)
  const model = buildModel(provider, modelId ?? getProviderDefaultModel(provider))

  const response = await completeSimple(model, {
    systemPrompt: REWRITE_SYSTEM_PROMPT,
    messages: [
      { role: 'user' as const, content: transcript, timestamp: Date.now() },
    ],
  }, { apiKey })

  const text = response.content
    .filter(c => c.type === 'text')
    .map(c => (c as { type: 'text'; text: string }).text)
    .join('')
    .trim()

  if (!text) {
    throw new Error('Rewrite returned no content.')
  }

  return text
}

// ── Language code resolution ──────────────────────────────────────────

/**
 * Map full language names (as stored in settings.json) to ISO-639-1 codes
 * expected by the transcription APIs.
 */
const LANGUAGE_TO_ISO: Record<string, string> = {
  english: 'en',
  german: 'de',
  french: 'fr',
  spanish: 'es',
  italian: 'it',
  portuguese: 'pt',
  dutch: 'nl',
  russian: 'ru',
  chinese: 'zh',
  japanese: 'ja',
  korean: 'ko',
}

/**
 * Resolve a language setting value to an ISO-639-1 code.
 * If the value is already a 2-3 letter code, return it as-is.
 * If it's a full name (e.g. "German"), map it to the code (e.g. "de").
 */
function resolveLanguageCode(lang: string | undefined): string | undefined {
  if (!lang) return undefined
  if (lang.length <= 3) return lang.toLowerCase()
  return LANGUAGE_TO_ISO[lang.toLowerCase()]
}

// ── Dispatcher ────────────────────────────────────────────────────────

export async function transcribeAudio(
  buffer: Buffer,
  options: TranscribeOptions = {},
): Promise<TranscribeResult> {
  const settings = loadSttSettings()

  if (!settings.enabled) {
    throw new Error('STT is not enabled. Enable it in Settings → Speech-to-Text.')
  }
  if (!buffer || buffer.length === 0) {
    throw new Error('STT: audio is empty.')
  }

  const { provider, modelId } = resolveVoiceModelRef(settings.model, 'stt')
  // The STT language override wins over the chat language so multilingual
  // setups (Telegram in DE, agent in EN) keep working.
  const language = settings.language.trim() || resolveLanguageCode(options.language)
  const transcript = await transcribeWithProvider(provider, {
    audio: buffer,
    modelId,
    language,
    filename: options.filename,
  })

  if (settings.rewrite.enabled && settings.rewrite.providerId) {
    try {
      const rewritten = await rewriteTranscript(transcript, settings.rewrite.providerId)
      return { transcript, rewritten }
    } catch (err) {
      // Rewrite failure is non-fatal — return raw transcript
      console.warn(`[stt] Rewrite failed, returning raw transcript: ${(err as Error).message}`)
      return { transcript }
    }
  }

  return { transcript }
}
