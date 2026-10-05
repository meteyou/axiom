import type { OAuthCredentials } from '@earendil-works/pi-ai/oauth'
import type { Database } from '@axiom/core'
import type { ProviderQuotaContract } from '@axiom/core/contracts'

export interface ProvidersRouterOptions {
  db?: Database
  onActiveProviderChanged?: () => void
  onFallbackProviderChanged?: () => void
  /** Called after settings/cronjob references to a disabled provider or model were reset to default. */
  onProviderReferencesReset?: () => void
  /** Called when the set of usable image generation models changed. */
  onImageModelsChanged?: () => void
  getQuotaSnapshot?: () => Record<string, ProviderQuotaContract>
  refreshQuota?: (providerId: string) => Promise<ProviderQuotaContract | null>
}

export interface PendingOAuthLogin {
  status: 'pending' | 'completed' | 'error'
  providerType: string
  name: string
  enabledModels: string[]
  textVerbosity?: 'low' | 'medium' | 'high' | null
  transport?: 'sse' | 'websocket' | 'websocket-cached' | 'auto' | null
  authUrl?: string
  instructions?: string
  credentials?: OAuthCredentials
  error?: string
  resolveManualCode?: (code: string) => void
  createdAt: number
  existingProviderId?: string
}

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
