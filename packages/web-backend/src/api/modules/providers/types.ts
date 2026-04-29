import type { OAuthCredentials } from '@mariozechner/pi-ai/oauth'
import type {
  ProviderActivationResponseContract,
  ProviderContract,
  ProviderFallbackResponseContract,
  ProviderTestResultContract,
  ProvidersListResponseContract,
  OAuthStatusResponseContract,
} from '@axiom/core/contracts'

export interface ProvidersRouterOptions {
  onActiveProviderChanged?: () => void
  onFallbackProviderChanged?: () => void
}

export interface PendingOAuthLogin {
  status: 'pending' | 'completed' | 'error'
  providerType: string
  name: string
  defaultModel: string
  authUrl?: string
  instructions?: string
  credentials?: OAuthCredentials
  error?: string
  resolveManualCode?: (code: string) => void
  createdAt: number
  existingProviderId?: string
}

export interface ProvidersListData {
  providers: ProvidersListResponseContract['providers']
  activeProvider: string | null
  activeModel: string | null
  fallbackProvider: string | null
  fallbackModel: string | null
  presets: ProvidersListResponseContract['presets']
}

export interface ProvidersMutationData {
  provider: ProviderContract
}

export type ProviderActivationData = ProviderActivationResponseContract
export type ProviderFallbackData = ProviderFallbackResponseContract
export type ProviderTestData = ProviderTestResultContract & {
  latencyMs?: number
  status?: string
  modelId?: string
}

export type OAuthStatusData = OAuthStatusResponseContract

export interface OllamaTagsResponse {
  models?: Array<{
    name: string
    size: number
    details?: {
      parameter_size?: string
      quantization_level?: string
      family?: string
    }
  }>
}
