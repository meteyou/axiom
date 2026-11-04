import type { VoiceModelKindContract } from './contracts/providers.js'

export type VoiceModelKind = VoiceModelKindContract

export type VoiceBackendId = 'openai' | 'openai-compatible' | 'mistral' | 'openrouter' | 'xai' | 'deepgram'

/** Every voice provider serves STT and TTS models and accepts model ids outside its list. */
const VOICE_BACKEND_BY_PROVIDER_TYPE: Record<string, VoiceBackendId> = {
  openai: 'openai',
  'custom-openai-completions': 'openai-compatible',
  'custom-openai-responses': 'openai-compatible',
  mistral: 'mistral',
  openrouter: 'openrouter',
  xai: 'xai',
  deepgram: 'deepgram',
}

/** Voice backend of a provider type, `null` when it serves no STT/TTS models. */
export function getVoiceBackendId(providerType: string): VoiceBackendId | null {
  return VOICE_BACKEND_BY_PROVIDER_TYPE[providerType] ?? null
}

export function supportsVoiceModels(providerType: string): boolean {
  return getVoiceBackendId(providerType) !== null
}
