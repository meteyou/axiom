/**
 * Text-to-Speech dispatcher. Reads the saved settings, resolves the selected
 * `providerId:modelId` TTS model and synthesizes through the provider's voice
 * backend. Lives in core so non-HTTP callers (the Telegram bot) can use it.
 */

import { ensureConfigTemplates, loadConfig } from './config.js'
import { normalizeTtsSettings } from './contracts/settings.js'
import type { TtsSettingsContract } from './contracts/settings.js'
import type { SynthesizedAudio } from './voice-backends.js'
import { resolveVoiceModelRef, synthesizeWithProvider } from './voice-models.js'

export type TtsSettings = TtsSettingsContract
export type SynthesizeResult = SynthesizedAudio

export interface SynthesizeOptions {
  /** Override the saved settings for this call (e.g. the unsaved settings preview). */
  settings?: Partial<Pick<TtsSettings, 'model' | 'voice' | 'instructions' | 'responseFormat'>>
  /** Synthesize even when TTS is disabled (settings preview). */
  ignoreEnabled?: boolean
}

export function loadTtsSettings(): TtsSettings {
  ensureConfigTemplates()
  const settings = loadConfig<Record<string, unknown>>('settings.json')
  return normalizeTtsSettings(settings.tts as Partial<TtsSettings> | undefined)
}

/**
 * Synthesize `text` with the configured TTS model. Throws when TTS is
 * disabled or no usable model is configured — callers decide how loud the
 * failure surfaces.
 */
export async function synthesizeTts(
  text: string,
  options: SynthesizeOptions = {},
): Promise<SynthesizeResult> {
  const saved = loadTtsSettings()
  if (!saved.enabled && !options.ignoreEnabled) {
    throw new Error('TTS is not enabled. Enable it in Settings → Text-to-Speech.')
  }
  const settings = normalizeTtsSettings({ ...saved, ...options.settings })
  const trimmed = text?.trim() ?? ''
  if (!trimmed) {
    throw new Error('TTS: input text is empty.')
  }

  const { provider, modelId } = resolveVoiceModelRef(settings.model, 'tts')
  return synthesizeWithProvider(provider, {
    text: trimmed,
    modelId,
    voice: settings.voice || undefined,
    instructions: settings.instructions || undefined,
    format: settings.responseFormat,
  })
}

/** Strip markdown so the synthesized speech doesn't read out backticks, asterisks, list markers, etc. */
export function stripMarkdownForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^>\s+/gm, '')
    .replace(/^[-*_]{3,}\s*$/gm, '')
    .replace(/^[\s]*[-*+]\s+/gm, '')
    .replace(/^[\s]*\d+\.\s+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
