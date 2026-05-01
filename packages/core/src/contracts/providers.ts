import type { ProviderType } from '../provider-config.js'

export type ProviderStatusContract = 'connected' | 'error' | 'untested'
export type ProviderAuthMethodContract = 'api-key' | 'oauth'
export type ProviderTextVerbosityContract = 'low' | 'medium' | 'high'

export interface ProviderContract {
  id: string
  name: string
  type: string
  providerType: ProviderType | string
  provider: string
  baseUrl: string
  apiKey: string
  apiKeyMasked: string
  defaultModel: string
  enabledModels?: string[]
  degradedThresholdMs?: number
  textVerbosity?: ProviderTextVerbosityContract
  status?: ProviderStatusContract
  modelStatuses?: Record<string, ProviderStatusContract>
  authMethod?: ProviderAuthMethodContract
  oauthCredentials?: { expires: number }
  cost?: { input: number; output: number } | null
  modelCosts?: Record<string, { input: number; output: number }>
}

export interface ProviderTypePresetContract {
  type: ProviderType | string
  label: string
  apiType: string
  providerName: string
  baseUrl: string
  requiresApiKey: boolean
  urlEditable: boolean
  piAiProvider: string | null
  /**
   * True if the provider type has a known catalog of models (either via
   * pi-ai's registry or via local PROVIDER_TYPE_MODEL_OVERRIDES). The UI
   * uses this to decide whether to render the checkbox list of enabled
   * models instead of a free-text model input.
   */
  hasKnownModels: boolean
  authMethod: ProviderAuthMethodContract
  oauthProviderId?: string
}

export interface AvailableModelContract {
  id: string
  name: string
}

export interface OllamaModelContract {
  name: string
  size: number
  parameterSize: string
  quantization: string
  family: string
}

export interface OllamaPullEventContract {
  status?: string
  total?: number
  completed?: number
  error?: string
  done?: boolean
}

export interface ProvidersListResponseContract {
  providers: ProviderContract[]
  activeProvider: string | null
  activeModel: string | null
  fallbackProvider: string | null
  fallbackModel: string | null
  presets: Record<string, ProviderTypePresetContract>
}

export interface ProviderMutationResponseContract {
  provider: ProviderContract
}

export interface ProviderTestResultContract {
  success: boolean
  message?: string
  error?: string
}

export interface ProviderActivationResponseContract {
  activeProvider: string
  activeModel: string | null
}

export interface ProviderFallbackResponseContract {
  fallbackProvider: string | null
  fallbackModel: string | null
}

export interface OAuthLoginResponseContract {
  loginId: string
  authUrl: string
  instructions?: string
  usesCallbackServer: boolean
}

export interface OAuthStatusResponseContract {
  status: 'pending' | 'completed' | 'error'
  provider?: ProviderContract
  error?: string
}

export interface ProviderCreatePayloadContract {
  name: string
  providerType: string
  baseUrl?: string
  apiKey?: string
  defaultModel: string
  enabledModels?: string[]
  degradedThresholdMs?: number
  textVerbosity?: ProviderTextVerbosityContract | null
}

export interface ProviderUpdatePayloadContract {
  name?: string
  providerType?: string
  baseUrl?: string
  apiKey?: string
  defaultModel?: string
  enabledModels?: string[]
  degradedThresholdMs?: number
  textVerbosity?: ProviderTextVerbosityContract | null
}

export interface ProviderFallbackUpdatePayloadContract {
  providerId?: string | null
  modelId?: string | null
}

export interface ProviderOAuthLoginStartPayloadContract {
  providerType: string
  name: string
  defaultModel: string
  providerId?: string
  textVerbosity?: ProviderTextVerbosityContract | null
}

export interface ProviderOAuthCodePayloadContract {
  code: string
}

export interface ProviderModelSelectionPayloadContract {
  modelId?: string
}

export interface ProviderReferenceContract {
  id: string
  defaultModel: string
}

/**
 * Canonicalize provider selectors to "providerId:modelId" while keeping legacy values valid.
 *
 * Compatibility behavior:
 * - "providerId:modelId" stays unchanged
 * - legacy "providerId" expands to "providerId:defaultModel" when provider is known
 * - unknown values are returned unchanged
 */
export function canonicalizeProviderModelRef(
  value: string | null | undefined,
  providers: readonly ProviderReferenceContract[],
): string {
  if (!value) return ''

  const trimmed = value.trim()
  if (!trimmed) return ''

  if (trimmed.includes(':')) {
    return trimmed
  }

  const provider = providers.find((candidate) => candidate.id === trimmed)
  if (!provider) return trimmed

  return `${provider.id}:${provider.defaultModel}`
}
