import type { VoiceModelKindContract } from './contracts/providers.js'

export type VoiceModelKind = VoiceModelKindContract

export type VoiceBackendId = 'openai' | 'openai-compatible' | 'mistral' | 'openrouter' | 'xai' | 'deepgram'

export interface VoiceProviderCapabilities {
  backend: VoiceBackendId
  kinds: readonly VoiceModelKind[]
  /** Model ids outside the provider's list can be added. */
  customModels: boolean
}

const BOTH: readonly VoiceModelKind[] = ['stt', 'tts']

const VOICE_CAPABILITIES: Record<string, VoiceProviderCapabilities> = {
  openai: { backend: 'openai', kinds: BOTH, customModels: true },
  'custom-openai-completions': { backend: 'openai-compatible', kinds: BOTH, customModels: true },
  'custom-openai-responses': { backend: 'openai-compatible', kinds: BOTH, customModels: true },
  mistral: { backend: 'mistral', kinds: BOTH, customModels: true },
  openrouter: { backend: 'openrouter', kinds: BOTH, customModels: true },
  xai: { backend: 'xai', kinds: BOTH, customModels: true },
  deepgram: { backend: 'deepgram', kinds: BOTH, customModels: true },
}

/** Voice model traits of a provider type, `null` when it serves no STT/TTS models. */
export function getVoiceProviderCapabilities(providerType: string): VoiceProviderCapabilities | null {
  return VOICE_CAPABILITIES[providerType] ?? null
}

export function supportsVoiceModels(providerType: string, kind: VoiceModelKind): boolean {
  return getVoiceProviderCapabilities(providerType)?.kinds.includes(kind) ?? false
}
