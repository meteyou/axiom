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
  textVerbosity?: 'low' | 'medium' | 'high' | null
  authUrl?: string
  instructions?: string
  credentials?: OAuthCredentials
  error?: string
  resolveManualCode?: (code: string) => void
  createdAt: number
  existingProviderId?: string
}

interface ProvidersListData {
  providers: ProvidersListResponseContract['providers']
  activeProvider: string | null
  activeModel: string | null
  fallbackProvider: string | null
  fallbackModel: string | null
  presets: ProvidersListResponseContract['presets']
}

interface ProvidersMutationData {
  provider: ProviderContract
}

type ProviderActivationData = ProviderActivationResponseContract
type ProviderFallbackData = ProviderFallbackResponseContract
type ProviderTestData = ProviderTestResultContract & {
  latencyMs?: number
  status?: string
  modelId?: string
}

type OAuthStatusData = OAuthStatusResponseContract

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
