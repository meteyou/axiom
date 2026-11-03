import { getApiKeyForProvider, getUsableVoiceModels, loadProvidersDecrypted, parseProviderModelId, PROVIDER_TYPE_PRESETS } from './provider-config.js'
import type { ProviderConfig, ProviderType } from './provider-config.js'
import { getVoiceBackend } from './voice-backends.js'
import type {
  AvailableVoiceModel,
  SynthesizedAudio,
  VoiceOption,
  VoiceTranscription,
  VoiceRequestContext,
  VoiceSynthesizeRequest,
  VoiceTranscribeRequest,
} from './voice-backends.js'
import { getVoiceProviderCapabilities } from './voice-capabilities.js'
import type { VoiceModelKind } from './voice-capabilities.js'

const MODEL_LIST_TIMEOUT_MS = 15_000
const TRANSCRIBE_TIMEOUT_MS = 180_000
const SYNTHESIZE_TIMEOUT_MS = 180_000

interface VoiceCallOptions {
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

function requireBackend(provider: ProviderConfig) {
  const capabilities = getVoiceProviderCapabilities(provider.providerType)
  if (!capabilities) throw new Error(`Provider "${provider.name}" does not support voice models`)
  return getVoiceBackend(capabilities.backend)
}

async function requestContext(provider: ProviderConfig, options: VoiceCallOptions, defaultTimeoutMs: number): Promise<VoiceRequestContext> {
  return {
    baseUrl: provider.baseUrl || PROVIDER_TYPE_PRESETS[provider.providerType as ProviderType]?.baseUrl || '',
    apiKey: await getApiKeyForProvider(provider),
    fetchImpl: options.fetchImpl,
    signal: AbortSignal.timeout(options.timeoutMs ?? defaultTimeoutMs),
  }
}

/** STT or TTS models the provider offers right now. */
export async function listLiveVoiceModels(
  provider: ProviderConfig,
  kind: VoiceModelKind,
  options: VoiceCallOptions = {},
): Promise<AvailableVoiceModel[]> {
  const backend = requireBackend(provider)
  return backend.listModels(await requestContext(provider, options, MODEL_LIST_TIMEOUT_MS), kind)
}

/** Voices of a TTS model; `null` when the model id already selects the voice. */
export async function listTtsModelVoices(
  provider: ProviderConfig,
  modelId: string,
  options: VoiceCallOptions = {},
): Promise<VoiceOption[] | null> {
  const backend = requireBackend(provider)
  if (!backend.listVoices) return null
  return backend.listVoices(await requestContext(provider, options, MODEL_LIST_TIMEOUT_MS), modelId)
}

export interface VoiceModelAvailabilityResult {
  status: 'healthy' | 'down'
  latencyMs: number | null
  errorMessage?: string
}

/** Free availability check: the provider must accept the key and still list the model. */
export async function checkVoiceModelAvailability(
  provider: ProviderConfig,
  kind: VoiceModelKind,
  modelId: string,
  options: VoiceCallOptions = {},
): Promise<VoiceModelAvailabilityResult> {
  const startedAt = Date.now()
  try {
    const models = await listLiveVoiceModels(provider, kind, options)
    const latencyMs = Date.now() - startedAt
    if (!models.some(model => model.id === modelId)) {
      return { status: 'down', latencyMs, errorMessage: `"${modelId}" is not offered by "${provider.name}"` }
    }
    return { status: 'healthy', latencyMs }
  } catch (err) {
    return { status: 'down', latencyMs: Date.now() - startedAt, errorMessage: (err as Error).message }
  }
}

export async function transcribeWithProvider(
  provider: ProviderConfig,
  request: VoiceTranscribeRequest,
  options: VoiceCallOptions = {},
): Promise<VoiceTranscription> {
  const backend = requireBackend(provider)
  return backend.transcribe(await requestContext(provider, options, TRANSCRIBE_TIMEOUT_MS), request)
}

export async function synthesizeWithProvider(
  provider: ProviderConfig,
  request: VoiceSynthesizeRequest,
  options: VoiceCallOptions = {},
): Promise<SynthesizedAudio> {
  const backend = requireBackend(provider)
  return backend.synthesize(await requestContext(provider, options, SYNTHESIZE_TIMEOUT_MS), request)
}

/**
 * Resolve a `providerId:modelId` voice model reference from the settings to a
 * usable provider. Throws with a user-facing message when the reference is
 * empty, unknown or points at a disabled provider/model.
 */
export function resolveVoiceModelRef(ref: string, kind: VoiceModelKind): { provider: ProviderConfig; modelId: string } {
  const label = kind === 'stt' ? 'Speech-to-Text' : 'Text-to-Speech'
  const { providerId, modelId } = parseProviderModelId(ref || undefined)
  if (!providerId || !modelId) {
    throw new Error(`No ${kind.toUpperCase()} model selected. Choose one in Settings → ${label}.`)
  }
  const provider = loadProvidersDecrypted().providers.find(p => p.id === providerId)
  if (!provider) {
    throw new Error(`${kind.toUpperCase()} provider not found: ${providerId}. Choose a model in Settings → ${label}.`)
  }
  if (!getUsableVoiceModels(provider, kind).includes(modelId)) {
    throw new Error(`${kind.toUpperCase()} model "${modelId}" is not enabled for provider "${provider.name}".`)
  }
  return { provider, modelId }
}
