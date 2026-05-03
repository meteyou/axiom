import type { OAuthCredentials } from '@mariozechner/pi-ai/oauth'

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
