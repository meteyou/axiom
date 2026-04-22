import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { Api, KnownProvider, Model } from '@mariozechner/pi-ai'
import { getModels as getPiAiModels } from '@mariozechner/pi-ai'
import { getOAuthProvider, getOAuthApiKey } from '@mariozechner/pi-ai/oauth'
import type { OAuthCredentials } from '@mariozechner/pi-ai/oauth'
import { getConfigDir, ensureConfigTemplates, loadConfig } from './config.js'
import { encrypt, decrypt, isEncrypted, maskApiKey } from './encryption.js'

/**
 * Claude Code CLI version to advertise in the user-agent header for Anthropic requests.
 * This ensures Anthropic treats requests as coming from a Claude Code client.
 */
export const CLAUDE_CODE_VERSION = '2.1.96'

/**
 * Supported provider types with presets
 */
export type ProviderType =
  | 'openai' | 'anthropic' | 'mistral' | 'ollama' | 'openrouter' | 'kimi' | 'zai' | 'opencode-go'
  // Legacy aliases kept for migration
  | 'ollama-local' | 'ollama-cloud'
  | 'openai-codex' | 'github-copilot' | 'google-gemini-cli' | 'google-antigravity' | 'anthropic-oauth'

export type AuthMethod = 'api-key' | 'oauth'

export interface ProviderTypePreset {
  type: ProviderType
  label: string
  apiType: string // pi-ai API type (used for api-key providers)
  providerName: string
  baseUrl: string
  requiresApiKey: boolean
  urlEditable: boolean
  piAiProvider: string | null // maps to pi-ai KnownProvider for model lookup
  authMethod: AuthMethod
  oauthProviderId?: string // pi-ai OAuth provider ID
}

export interface AvailableModel {
  id: string
  name: string
}

export const PROVIDER_TYPE_PRESETS: Record<ProviderType, ProviderTypePreset> = {
  // ── API Key providers ──
  openai: {
    type: 'openai',
    label: 'OpenAI',
    apiType: 'openai-completions',
    providerName: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    requiresApiKey: true,
    urlEditable: false,
    piAiProvider: 'openai',
    authMethod: 'api-key',
  },
  anthropic: {
    type: 'anthropic',
    label: 'Anthropic',
    apiType: 'anthropic-messages',
    providerName: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    requiresApiKey: true,
    urlEditable: false,
    piAiProvider: 'anthropic',
    authMethod: 'api-key',
  },
  mistral: {
    type: 'mistral',
    label: 'Mistral',
    apiType: 'mistral-conversations',
    providerName: 'mistral',
    baseUrl: 'https://api.mistral.ai',
    requiresApiKey: true,
    urlEditable: false,
    piAiProvider: 'mistral',
    authMethod: 'api-key',
  },
  'ollama': {
    type: 'ollama',
    label: 'Ollama',
    apiType: 'openai-completions',
    providerName: 'ollama',
    baseUrl: 'http://localhost:11434/v1',
    requiresApiKey: false,
    urlEditable: true,
    piAiProvider: null,
    authMethod: 'api-key',
  },
  // Legacy aliases — map to 'ollama' so existing configs still load
  'ollama-local': {
    type: 'ollama',
    label: 'Ollama',
    apiType: 'openai-completions',
    providerName: 'ollama',
    baseUrl: 'http://localhost:11434/v1',
    requiresApiKey: false,
    urlEditable: true,
    piAiProvider: null,
    authMethod: 'api-key',
  },
  'ollama-cloud': {
    type: 'ollama',
    label: 'Ollama',
    apiType: 'openai-completions',
    providerName: 'ollama',
    baseUrl: 'http://localhost:11434/v1',
    requiresApiKey: false,
    urlEditable: true,
    piAiProvider: null,
    authMethod: 'api-key',
  },
  openrouter: {
    type: 'openrouter',
    label: 'OpenRouter',
    apiType: 'openai-completions',
    providerName: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    requiresApiKey: true,
    urlEditable: false,
    piAiProvider: null,
    authMethod: 'api-key',
  },
  kimi: {
    type: 'kimi',
    label: 'Kimi / Moonshot',
    apiType: 'openai-completions',
    providerName: 'moonshot',
    baseUrl: 'https://api.moonshot.ai/v1',
    requiresApiKey: true,
    urlEditable: false,
    // The Moonshot Platform catalog is maintained locally in
    // PROVIDER_TYPE_MODEL_OVERRIDES below because pi-ai's `kimi-coding`
    // provider targets a different endpoint (api.kimi.com/coding,
    // anthropic-messages) and does not list the platform models.
    piAiProvider: null,
    authMethod: 'api-key',
  },
  zai: {
    type: 'zai',
    label: 'z.ai',
    apiType: 'openai-completions',
    providerName: 'zai',
    baseUrl: 'https://api.z.ai/api/coding/paas/v4',
    requiresApiKey: true,
    urlEditable: false,
    piAiProvider: 'zai',
    authMethod: 'api-key',
  },
  'opencode-go': {
    type: 'opencode-go',
    label: 'OpenCode Go',
    apiType: 'openai-completions',
    providerName: 'opencode-go',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    requiresApiKey: true,
    urlEditable: false,
    piAiProvider: null,
    authMethod: 'api-key',
  },

  // ── OAuth / Subscription providers ──
  'openai-codex': {
    type: 'openai-codex',
    label: 'ChatGPT Plus/Pro (Codex)',
    apiType: 'openai-codex-responses',
    providerName: 'openai-codex',
    baseUrl: '',
    requiresApiKey: false,
    urlEditable: false,
    piAiProvider: 'openai-codex',
    authMethod: 'oauth',
    oauthProviderId: 'openai-codex',
  },
  'github-copilot': {
    type: 'github-copilot',
    label: 'GitHub Copilot',
    apiType: 'openai-completions',
    providerName: 'github-copilot',
    baseUrl: '',
    requiresApiKey: false,
    urlEditable: false,
    piAiProvider: 'github-copilot',
    authMethod: 'oauth',
    oauthProviderId: 'github-copilot',
  },
  'google-gemini-cli': {
    type: 'google-gemini-cli',
    label: 'Google Gemini (Free)',
    apiType: 'google-gemini-cli',
    providerName: 'google-gemini-cli',
    baseUrl: '',
    requiresApiKey: false,
    urlEditable: false,
    piAiProvider: 'google-gemini-cli',
    authMethod: 'oauth',
    oauthProviderId: 'google-gemini-cli',
  },
  'google-antigravity': {
    type: 'google-antigravity',
    label: 'Google Antigravity (Free)',
    apiType: 'google-gemini-cli',
    providerName: 'google-antigravity',
    baseUrl: '',
    requiresApiKey: false,
    urlEditable: false,
    piAiProvider: 'google-antigravity',
    authMethod: 'oauth',
    oauthProviderId: 'google-antigravity',
  },
  'anthropic-oauth': {
    type: 'anthropic-oauth',
    label: 'Anthropic (Claude Pro/Max)',
    apiType: 'anthropic-messages',
    providerName: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    requiresApiKey: false,
    urlEditable: false,
    piAiProvider: 'anthropic',
    authMethod: 'oauth',
    oauthProviderId: 'anthropic',
  },
}

/**
 * Local catalog overrides for provider types whose model list is not well
 * represented in pi-ai. Entries here take precedence over pi-ai and also feed
 * buildModel() with metadata (contextWindow, maxTokens, cost, reasoning) so
 * the UI and cost estimation work without requiring users to configure each
 * model manually.
 *
 * Keep this list in sync with the upstream provider's published catalog.
 */
export const PROVIDER_TYPE_MODEL_OVERRIDES: Partial<Record<ProviderType, ProviderModelConfig[]>> = {
  // OpenCode Go — subscription plan by the OpenCode team ($5 first month, $10/month)
  // OpenAI-compatible endpoint: https://opencode.ai/zen/go/v1/chat/completions
  // MiniMax M2.x use the Anthropic-compatible endpoint and are intentionally excluded here;
  // they require a separate provider entry with apiType 'anthropic-messages'.
  // Pricing is subscription-based (flat fee), so per-token costs are set to 0.
  // Model IDs confirmed from https://opencode.ai/docs/go/ (April 2026).
  'opencode-go': [
    { id: 'glm-5.1', name: 'GLM-5.1', contextWindow: 131_072, maxTokens: 16_384, reasoning: true,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    { id: 'glm-5', name: 'GLM-5', contextWindow: 131_072, maxTokens: 16_384, reasoning: false,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    { id: 'kimi-k2.6', name: 'Kimi K2.6', contextWindow: 262_144, maxTokens: 32_768, reasoning: true,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    { id: 'kimi-k2.5', name: 'Kimi K2.5', contextWindow: 262_144, maxTokens: 32_768, reasoning: true,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    { id: 'mimo-v2-pro', name: 'MiMo-V2-Pro', contextWindow: 131_072, maxTokens: 16_384, reasoning: true,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    { id: 'mimo-v2-omni', name: 'MiMo-V2-Omni', contextWindow: 131_072, maxTokens: 16_384, reasoning: false,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    { id: 'qwen3.6-plus', name: 'Qwen3.6 Plus', contextWindow: 131_072, maxTokens: 16_384, reasoning: true,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    { id: 'qwen3.5-plus', name: 'Qwen3.5 Plus', contextWindow: 131_072, maxTokens: 16_384, reasoning: false,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
  ],
  // Moonshot Platform API (https://platform.moonshot.ai)
  // Confirmed via GET https://api.moonshot.ai/v1/models and official pricing docs.
  // Pricing in USD per 1M tokens.
  kimi: [
    // Current K2 family
    // Note: K2 reasoning models only accept `temperature: 1` (the upstream API
    // returns "invalid temperature: only 1 is allowed for this model" otherwise).
    { id: 'kimi-k2.6', name: 'Kimi K2.6', contextWindow: 262_144, maxTokens: 32_768, reasoning: true, fixedTemperature: 1,
      cost: { input: 0.6, output: 2.5, cacheRead: 0.15, cacheWrite: 0 } },
    { id: 'kimi-k2.5', name: 'Kimi K2.5', contextWindow: 262_144, maxTokens: 32_768, reasoning: true, fixedTemperature: 1,
      cost: { input: 0.6, output: 2.5, cacheRead: 0.15, cacheWrite: 0 } },
    { id: 'kimi-k2-thinking', name: 'Kimi K2 Thinking', contextWindow: 262_144, maxTokens: 32_768, reasoning: true, fixedTemperature: 1,
      cost: { input: 0.6, output: 2.5, cacheRead: 0.15, cacheWrite: 0 } },
    { id: 'kimi-k2-thinking-turbo', name: 'Kimi K2 Thinking Turbo', contextWindow: 262_144, maxTokens: 32_768, reasoning: true, fixedTemperature: 1,
      cost: { input: 2.4, output: 10.0, cacheRead: 0.6, cacheWrite: 0 } },
    { id: 'kimi-k2-turbo-preview', name: 'Kimi K2 Turbo (preview)', contextWindow: 262_144, maxTokens: 32_768, reasoning: false,
      cost: { input: 2.4, output: 10.0, cacheRead: 0.6, cacheWrite: 0 } },
    { id: 'kimi-k2-0905-preview', name: 'Kimi K2 0905 (preview)', contextWindow: 262_144, maxTokens: 32_768, reasoning: false,
      cost: { input: 0.6, output: 2.5, cacheRead: 0.15, cacheWrite: 0 } },
    { id: 'kimi-k2-0711-preview', name: 'Kimi K2 0711 (preview)', contextWindow: 131_072, maxTokens: 32_768, reasoning: false,
      cost: { input: 0.6, output: 2.5, cacheRead: 0.15, cacheWrite: 0 } },

    // Convenience alias that always points at the latest stable
    { id: 'kimi-latest', name: 'Kimi Latest', contextWindow: 131_072, maxTokens: 32_768, reasoning: false,
      cost: { input: 0.6, output: 2.5, cacheRead: 0.15, cacheWrite: 0 } },

    // Legacy moonshot-v1 line (still available on the platform)
    { id: 'moonshot-v1-auto', name: 'Moonshot v1 Auto', contextWindow: 131_072, maxTokens: 8_192, reasoning: false,
      cost: { input: 2.0, output: 5.0 } },
    { id: 'moonshot-v1-8k', name: 'Moonshot v1 8K', contextWindow: 8_192, maxTokens: 8_192, reasoning: false,
      cost: { input: 0.2, output: 1.0 } },
    { id: 'moonshot-v1-32k', name: 'Moonshot v1 32K', contextWindow: 32_768, maxTokens: 8_192, reasoning: false,
      cost: { input: 0.5, output: 1.5 } },
    { id: 'moonshot-v1-128k', name: 'Moonshot v1 128K', contextWindow: 131_072, maxTokens: 8_192, reasoning: false,
      cost: { input: 2.0, output: 5.0 } },
    { id: 'moonshot-v1-8k-vision-preview', name: 'Moonshot v1 8K Vision (preview)', contextWindow: 8_192, maxTokens: 8_192, reasoning: false,
      cost: { input: 0.2, output: 1.0 } },
    { id: 'moonshot-v1-32k-vision-preview', name: 'Moonshot v1 32K Vision (preview)', contextWindow: 32_768, maxTokens: 8_192, reasoning: false,
      cost: { input: 0.5, output: 1.5 } },
    { id: 'moonshot-v1-128k-vision-preview', name: 'Moonshot v1 128K Vision (preview)', contextWindow: 131_072, maxTokens: 8_192, reasoning: false,
      cost: { input: 2.0, output: 5.0 } },
  ],
}

/**
 * Get available models for a given provider type.
 *
 * Resolution order:
 *  1. PROVIDER_TYPE_MODEL_OVERRIDES (local catalog — takes precedence)
 *  2. pi-ai's generated model list for the preset's piAiProvider
 */
export function getAvailableModels(providerType: ProviderType): AvailableModel[] {
  const overrides = PROVIDER_TYPE_MODEL_OVERRIDES[providerType]
  if (overrides && overrides.length > 0) {
    return overrides.map(m => ({ id: m.id, name: m.name ?? m.id }))
  }

  const preset = PROVIDER_TYPE_PRESETS[providerType]
  if (!preset?.piAiProvider) {
    return []
  }

  try {
    const models = getPiAiModels(preset.piAiProvider as KnownProvider)
    return models.map(m => ({ id: m.id, name: m.name }))
  } catch {
    return []
  }
}

/**
 * Look up an override model config by provider type and model id, if any.
 */
function findOverrideModel(providerType: ProviderType | undefined, modelId: string): ProviderModelConfig | undefined {
  if (!providerType) return undefined
  const overrides = PROVIDER_TYPE_MODEL_OVERRIDES[providerType]
  return overrides?.find(m => m.id === modelId)
}

/**
 * Resolve the effective sampling temperature for a given provider+model.
 *
 * Some upstream APIs reject any temperature other than a specific value (for
 * example, Moonshot's Kimi K2 thinking models only accept `temperature: 1`).
 * Callers should route their desired temperature through this helper so such
 * constraints are honored without scattering model-specific knowledge across
 * the codebase.
 *
 * Resolution order for the constraint:
 *   1. `provider.models[].fixedTemperature` (per-provider user override)
 *   2. `PROVIDER_TYPE_MODEL_OVERRIDES[...].fixedTemperature` (local catalog)
 *
 * If no constraint applies, the `requested` value is returned unchanged.
 */
export function resolveModelTemperature(
  provider: Pick<ProviderConfig, 'providerType' | 'models'>,
  modelId: string,
  requested: number,
): number {
  const configured = provider.models?.find(m => m.id === modelId)
  if (configured?.fixedTemperature !== undefined) {
    return configured.fixedTemperature
  }
  const override = findOverrideModel(provider.providerType, modelId)
  if (override?.fixedTemperature !== undefined) {
    return override.fixedTemperature
  }
  return requested
}

/**
 * Provider configuration as stored in providers.json
 */
export interface ProviderConfig {
  id: string
  name: string
  type: string // e.g., 'openai-completions', 'anthropic-messages'
  providerType: ProviderType // e.g., 'openai', 'anthropic', 'ollama'
  provider: string // e.g., 'openai', 'anthropic', 'xai'
  baseUrl: string
  apiKey: string // encrypted at rest
  defaultModel: string
  enabledModels?: string[] // list of model IDs enabled for this provider
  degradedThresholdMs?: number
  models?: ProviderModelConfig[]
  status?: 'connected' | 'error' | 'untested'
  modelStatuses?: Record<string, 'connected' | 'error' | 'untested'>
  authMethod?: AuthMethod
  oauthCredentials?: OAuthCredentialsStored // encrypted at rest
}

/**
 * OAuth credentials as stored in providers.json (encrypted)
 */
export interface OAuthCredentialsStored {
  refresh: string // encrypted
  access: string // encrypted
  expires: number
  extra?: string // encrypted JSON of additional fields
}

export interface ProviderModelConfig {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  reasoning?: boolean
  /**
   * If set, the upstream API only accepts this exact `temperature` value and
   * rejects any other value (e.g. Moonshot's Kimi K2 thinking models require
   * `temperature: 1`). Callers should pass the requested value through
   * `resolveModelTemperature()` so this constraint is honored.
   */
  fixedTemperature?: number
  cost?: {
    input: number
    output: number
    cacheRead?: number
    cacheWrite?: number
  }
}

export interface ProvidersFile {
  providers: ProviderConfig[]
  activeProvider?: string
  activeModel?: string // model ID within the active provider
  fallbackProvider?: string
  fallbackModel?: string // model ID within the fallback provider
  _comment?: string
}

/**
 * Price table for common models (cost per million tokens in USD)
 * Used as fallback when pi-mono cost data is not available
 */
export type TokenPriceTable = Record<string, { input: number; output: number }>

export const DEFAULT_PRICE_TABLE: TokenPriceTable = {
  'gpt-4o': { input: 2.50, output: 10.00 },
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'gpt-4-turbo': { input: 10.00, output: 30.00 },
  'gpt-3.5-turbo': { input: 0.50, output: 1.50 },
  'claude-sonnet-4-20250514': { input: 3.00, output: 15.00 },
  'claude-3-5-sonnet-20241022': { input: 3.00, output: 15.00 },
  'claude-3-opus-20240229': { input: 15.00, output: 75.00 },
  'claude-3-haiku-20240307': { input: 0.25, output: 1.25 },
}

/**
 * Load providers.json from config directory
 */
export function loadProviders(): ProvidersFile {
  const configDir = getConfigDir()
  const filePath = path.join(configDir, 'providers.json')

  if (!fs.existsSync(filePath)) {
    return { providers: [] }
  }

  const content = fs.readFileSync(filePath, 'utf-8')
  const data = JSON.parse(content) as ProvidersFile

  // Migrate legacy ollama-local / ollama-cloud → ollama
  let migrated = false
  for (const p of data.providers) {
    if (p.providerType === 'ollama-local' || p.providerType === 'ollama-cloud') {
      p.providerType = 'ollama' as ProviderType
      p.type = 'openai-completions'
      p.provider = 'ollama'
      migrated = true
    }
  }
  if (migrated) {
    // Persist the migration so it only runs once
    const outPath = path.join(configDir, 'providers.json')
    fs.writeFileSync(outPath, JSON.stringify(data, null, 2) + '\n', 'utf-8')
  }

  return data
}

/**
 * Save providers.json to config directory
 */
export function saveProviders(data: ProvidersFile): void {
  const configDir = getConfigDir()
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true })
  }
  const filePath = path.join(configDir, 'providers.json')
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8')
}

/**
 * Get providers with API keys decrypted
 */
export function loadProvidersDecrypted(): ProvidersFile {
  const file = loadProviders()
  return {
    ...file,
    providers: file.providers.map(p => {
      // Sync fixed URLs from presets (handles preset URL changes)
      const preset = PROVIDER_TYPE_PRESETS[p.providerType]
      const baseUrl = (preset && !preset.urlEditable) ? preset.baseUrl : p.baseUrl

      return {
        ...p,
        baseUrl,
        apiKey: p.apiKey && isEncrypted(p.apiKey) ? decrypt(p.apiKey) : p.apiKey,
        oauthCredentials: p.oauthCredentials ? decryptOAuthCredentials(p.oauthCredentials) : undefined,
      }
    }),
  }
}

/**
 * Get providers with API keys masked for display
 */
export function loadProvidersMasked(): ProvidersFile & { providers: (ProviderConfig & { apiKeyMasked: string })[] } {
  const file = loadProvidersDecrypted() // Already syncs URLs from presets
  return {
    ...file,
    providers: file.providers.map(p => ({
      ...p,
      apiKey: '', // Never send real key to frontend
      apiKeyMasked: p.apiKey ? maskApiKey(p.apiKey) : '',
      oauthCredentials: p.oauthCredentials ? { refresh: '', access: '', expires: p.oauthCredentials.expires } : undefined,
    })),
  }
}

/**
 * Encrypt OAuth credentials for storage
 */
export function encryptOAuthCredentials(creds: OAuthCredentials): OAuthCredentialsStored {
  const { refresh, access, expires, ...extra } = creds
  return {
    refresh: encrypt(refresh),
    access: encrypt(access),
    expires,
    extra: Object.keys(extra).length > 0 ? encrypt(JSON.stringify(extra)) : undefined,
  }
}

/**
 * Decrypt OAuth credentials from storage
 */
function decryptOAuthCredentials(stored: OAuthCredentialsStored): OAuthCredentialsStored {
  return {
    refresh: isEncrypted(stored.refresh) ? decrypt(stored.refresh) : stored.refresh,
    access: isEncrypted(stored.access) ? decrypt(stored.access) : stored.access,
    expires: stored.expires,
    extra: stored.extra && isEncrypted(stored.extra) ? decrypt(stored.extra) : stored.extra,
  }
}

/**
 * Convert stored OAuth credentials to pi-ai OAuthCredentials format
 */
export function storedToOAuthCredentials(stored: OAuthCredentialsStored): OAuthCredentials {
  const base: OAuthCredentials = {
    refresh: stored.refresh,
    access: stored.access,
    expires: stored.expires,
  }
  if (stored.extra) {
    try {
      const extraFields = JSON.parse(stored.extra) as Record<string, unknown>
      Object.assign(base, extraFields)
    } catch {
      // Ignore parse errors
    }
  }
  return base
}

/**
 * Generate a unique provider ID
 */
function generateProviderId(): string {
  return crypto.randomUUID()
}

/**
 * Add a new provider (API key based)
 */
export function addProvider(input: {
  name: string
  providerType: ProviderType
  baseUrl?: string
  apiKey?: string
  defaultModel: string
  enabledModels?: string[]
  degradedThresholdMs?: number
}): ProviderConfig {
  const preset = PROVIDER_TYPE_PRESETS[input.providerType]
  if (!preset) {
    throw new Error(`Unknown provider type: ${input.providerType}`)
  }

  const file = loadProviders()

  // Check for duplicate name
  if (file.providers.some(p => p.name === input.name)) {
    throw new Error(`Provider with name "${input.name}" already exists`)
  }

  // Ensure defaultModel is included in enabledModels
  const enabledModels = input.enabledModels && input.enabledModels.length > 0
    ? (input.enabledModels.includes(input.defaultModel)
        ? input.enabledModels
        : [input.defaultModel, ...input.enabledModels])
    : [input.defaultModel]

  const provider: ProviderConfig = {
    id: generateProviderId(),
    name: input.name,
    type: preset.apiType,
    providerType: input.providerType,
    provider: preset.providerName,
    baseUrl: input.baseUrl || preset.baseUrl,
    apiKey: input.apiKey ? encrypt(input.apiKey) : '',
    defaultModel: input.defaultModel,
    enabledModels,
    degradedThresholdMs: input.degradedThresholdMs ?? 5000,
    status: 'untested',
    authMethod: preset.authMethod,
  }

  file.providers.push(provider)

  // If this is the first provider, make it active
  if (file.providers.length === 1) {
    file.activeProvider = provider.id
    file.activeModel = input.defaultModel
  }

  saveProviders(file)
  return provider
}

/**
 * Add a new OAuth-authenticated provider
 */
export function addOAuthProvider(input: {
  name: string
  providerType: ProviderType
  defaultModel: string
  enabledModels?: string[]
  degradedThresholdMs?: number
  oauthCredentials: OAuthCredentials
}): ProviderConfig {
  const preset = PROVIDER_TYPE_PRESETS[input.providerType]
  if (!preset) {
    throw new Error(`Unknown provider type: ${input.providerType}`)
  }
  if (preset.authMethod !== 'oauth') {
    throw new Error(`Provider type "${input.providerType}" does not use OAuth`)
  }

  const file = loadProviders()

  // Check for duplicate name
  if (file.providers.some(p => p.name === input.name)) {
    throw new Error(`Provider with name "${input.name}" already exists`)
  }

  // Ensure defaultModel is included in enabledModels
  const enabledModels = input.enabledModels && input.enabledModels.length > 0
    ? (input.enabledModels.includes(input.defaultModel)
        ? input.enabledModels
        : [input.defaultModel, ...input.enabledModels])
    : [input.defaultModel]

  const provider: ProviderConfig = {
    id: generateProviderId(),
    name: input.name,
    type: preset.apiType,
    providerType: input.providerType,
    provider: preset.providerName,
    baseUrl: preset.baseUrl,
    apiKey: '',
    defaultModel: input.defaultModel,
    enabledModels,
    degradedThresholdMs: input.degradedThresholdMs ?? 5000,
    status: 'untested',
    authMethod: 'oauth',
    oauthCredentials: encryptOAuthCredentials(input.oauthCredentials),
  }

  file.providers.push(provider)

  if (file.providers.length === 1) {
    file.activeProvider = provider.id
    file.activeModel = input.defaultModel
  }

  saveProviders(file)
  return provider
}

/**
 * Update an existing provider
 */
export function updateProvider(id: string, input: {
  name?: string
  providerType?: ProviderType
  baseUrl?: string
  apiKey?: string
  defaultModel?: string
  enabledModels?: string[]
  degradedThresholdMs?: number
}): ProviderConfig {
  const file = loadProviders()
  const index = file.providers.findIndex(p => p.id === id)
  if (index === -1) {
    throw new Error(`Provider not found: ${id}`)
  }

  const existing = file.providers[index]

  // Check for duplicate name (if name is being changed)
  if (input.name && input.name !== existing.name && file.providers.some(p => p.name === input.name)) {
    throw new Error(`Provider with name "${input.name}" already exists`)
  }

  // If providerType is being changed, update derived fields
  if (input.providerType && input.providerType !== existing.providerType) {
    const preset = PROVIDER_TYPE_PRESETS[input.providerType]
    if (!preset) {
      throw new Error(`Unknown provider type: ${input.providerType}`)
    }
    existing.providerType = input.providerType
    existing.type = preset.apiType
    existing.provider = preset.providerName
    existing.authMethod = preset.authMethod
    if (!input.baseUrl) {
      existing.baseUrl = preset.baseUrl
    }
  }

  if (input.name !== undefined) existing.name = input.name
  if (input.baseUrl !== undefined) existing.baseUrl = input.baseUrl
  if (input.apiKey !== undefined) existing.apiKey = input.apiKey ? encrypt(input.apiKey) : ''
  if (input.defaultModel !== undefined) existing.defaultModel = input.defaultModel
  if (input.enabledModels !== undefined) {
    // Ensure defaultModel is always in enabledModels
    const dm = input.defaultModel ?? existing.defaultModel
    existing.enabledModels = input.enabledModels.includes(dm)
      ? input.enabledModels
      : [dm, ...input.enabledModels]
  }
  if (input.degradedThresholdMs !== undefined) existing.degradedThresholdMs = input.degradedThresholdMs

  // For providers with fixed URLs, always sync from preset
  const currentPreset = PROVIDER_TYPE_PRESETS[existing.providerType]
  if (currentPreset && !currentPreset.urlEditable) {
    existing.baseUrl = currentPreset.baseUrl
  }

  // Reset status when config changes
  existing.status = 'untested'

  file.providers[index] = existing
  saveProviders(file)
  return existing
}

/**
 * Update OAuth credentials for a provider
 */
export function updateOAuthCredentials(id: string, credentials: OAuthCredentials): void {
  const file = loadProviders()
  const provider = file.providers.find(p => p.id === id)
  if (!provider) return
  provider.oauthCredentials = encryptOAuthCredentials(credentials)
  saveProviders(file)
}

/**
 * Delete a provider
 */
export function deleteProvider(id: string): void {
  const file = loadProviders()
  const index = file.providers.findIndex(p => p.id === id)
  if (index === -1) {
    throw new Error(`Provider not found: ${id}`)
  }

  // Cannot delete the active provider
  if (file.activeProvider === id) {
    throw new Error('Cannot delete the active provider. Set another provider as active first.')
  }

  // Clean up fallback if it points to this provider
  if (file.fallbackProvider === id) {
    delete file.fallbackProvider
    delete file.fallbackModel
  }

  file.providers.splice(index, 1)
  saveProviders(file)
}

/**
 * Set the active provider
 */
export function setActiveProvider(id: string, modelId?: string): void {
  const file = loadProviders()
  const provider = file.providers.find(p => p.id === id)
  if (!provider) {
    throw new Error(`Provider not found: ${id}`)
  }
  file.activeProvider = id
  if (modelId !== undefined) {
    file.activeModel = modelId
  } else {
    file.activeModel = provider.defaultModel
  }
  saveProviders(file)
}

/**
 * Set the active model ID (within the current active provider).
 */
export function setActiveModel(modelId: string): void {
  const file = loadProviders()
  if (!file.activeProvider) {
    throw new Error('No active provider set')
  }
  const provider = file.providers.find(p => p.id === file.activeProvider)
  if (!provider) {
    throw new Error('Active provider not found')
  }
  const enabled = provider.enabledModels ?? [provider.defaultModel]
  if (!enabled.includes(modelId)) {
    throw new Error(`Model "${modelId}" is not enabled for provider "${provider.name}"`)
  }
  file.activeModel = modelId
  saveProviders(file)
}

/**
 * Get the active model ID.
 */
export function getActiveModelId(): string | null {
  const file = loadProviders()
  if (!file.activeProvider) return null
  const provider = file.providers.find(p => p.id === file.activeProvider)
  if (!provider) return null
  return file.activeModel ?? provider.defaultModel
}

/**
 * Update a provider's status
 */
export function updateProviderStatus(id: string, status: 'connected' | 'error' | 'untested', modelId?: string): void {
  const file = loadProviders()
  const provider = file.providers.find(p => p.id === id)
  if (!provider) return

  if (modelId) {
    // Update per-model status
    if (!provider.modelStatuses) provider.modelStatuses = {}
    provider.modelStatuses[modelId] = status
    // Also derive overall provider status from model statuses
    const enabled = provider.enabledModels ?? [provider.defaultModel]
    const statuses = enabled.map(m => provider.modelStatuses?.[m] ?? 'untested')
    if (statuses.every(s => s === 'connected')) provider.status = 'connected'
    else if (statuses.some(s => s === 'error')) provider.status = 'error'
    else provider.status = 'untested'
  } else {
    provider.status = status
  }

  saveProviders(file)
}

/**
 * Get the fallback provider configuration (decrypted), or null if not configured.
 */
export function getFallbackProvider(): ProviderConfig | null {
  const file = loadProvidersDecrypted()
  if (!file.fallbackProvider) return null

  const found = file.providers.find(p => p.id === file.fallbackProvider)
  return found ?? null
}

/**
 * Set the fallback provider by ID. Validates that the ID exists and is not the active provider.
 */
export function setFallbackProvider(id: string, modelId?: string): void {
  const file = loadProviders()
  const provider = file.providers.find(p => p.id === id)
  if (!provider) {
    throw new Error(`Provider not found: ${id}`)
  }
  if (file.activeProvider === id) {
    // Only reject if both provider AND model match the active selection
    const activeModel = file.activeModel ?? file.providers.find(p => p.id === file.activeProvider)?.defaultModel
    const fbModel = modelId ?? provider.defaultModel
    if (activeModel === fbModel) {
      throw new Error('Fallback cannot be the same provider and model as the active selection')
    }
  }
  file.fallbackProvider = id
  if (modelId !== undefined) {
    file.fallbackModel = modelId
  } else {
    file.fallbackModel = provider.defaultModel
  }
  saveProviders(file)
}

/**
 * Clear the fallback provider setting.
 */
export function clearFallbackProvider(): void {
  const file = loadProviders()
  delete file.fallbackProvider
  delete file.fallbackModel
  saveProviders(file)
}

/**
 * Get the fallback model ID.
 */
export function getFallbackModelId(): string | null {
  const file = loadProviders()
  if (!file.fallbackProvider) return null
  const provider = file.providers.find(p => p.id === file.fallbackProvider)
  if (!provider) return null
  return file.fallbackModel ?? provider.defaultModel
}

/**
 * Get the active provider configuration
 */
export function getActiveProvider(): ProviderConfig | null {
  const file = loadProvidersDecrypted()
  if (file.providers.length === 0) return null

  if (file.activeProvider) {
    const found = file.providers.find(p => p.id === file.activeProvider)
    if (found) return found
  }

  // Default to first provider
  return file.providers[0]
}

/**
 * Get API key for a provider, handling OAuth token refresh
 */
export async function getApiKeyForProvider(provider: ProviderConfig): Promise<string> {
  // API key providers: return the key directly
  if (provider.authMethod !== 'oauth' || !provider.oauthCredentials) {
    // For providers that don't require an API key (e.g., local Ollama),
    // return a dummy key to satisfy downstream libraries (like the OpenAI SDK)
    // that require a non-empty API key string.
    if (!provider.apiKey) {
      const preset = PROVIDER_TYPE_PRESETS[provider.providerType]
      if (preset && !preset.requiresApiKey) {
        return 'no-key'
      }
    }
    return provider.apiKey
  }

  const preset = PROVIDER_TYPE_PRESETS[provider.providerType]
  if (!preset?.oauthProviderId) {
    return provider.apiKey
  }

  // Convert stored credentials to pi-ai format
  const oauthCreds = storedToOAuthCredentials(provider.oauthCredentials)

  // Use pi-ai to get API key (auto-refreshes expired tokens)
  const result = await getOAuthApiKey(
    preset.oauthProviderId,
    { [preset.oauthProviderId]: oauthCreds },
  )

  if (!result) {
    throw new Error(`Failed to get API key for OAuth provider ${provider.name}. Re-login may be required.`)
  }

  // Save refreshed credentials if they changed
  if (result.newCredentials.access !== oauthCreds.access ||
      result.newCredentials.expires !== oauthCreds.expires) {
    updateOAuthCredentials(provider.id, result.newCredentials)
  }

  return result.apiKey
}

/**
 * Build a pi-ai Model object from a provider config
 */
export function getConfiguredPriceTable(): TokenPriceTable {
  try {
    ensureConfigTemplates()
    const settings = loadConfig<{ tokenPriceTable?: TokenPriceTable }>('settings.json')
    return {
      ...DEFAULT_PRICE_TABLE,
      ...(settings.tokenPriceTable ?? {}),
    }
  } catch {
    return { ...DEFAULT_PRICE_TABLE }
  }
}

export function buildModel(provider: ProviderConfig, modelId?: string): Model<Api> {
  const id = modelId ?? provider.defaultModel
  const preset = PROVIDER_TYPE_PRESETS[provider.providerType]

  // For OAuth providers, look up the model from pi-ai to get correct api type and metadata
  if (preset?.authMethod === 'oauth' && preset.piAiProvider) {
    try {
      const piAiModels = getPiAiModels(preset.piAiProvider as KnownProvider)

      // Let the OAuth provider modify models (e.g., set base URL for GitHub Copilot)
      let models: Model<Api>[] = piAiModels as Model<Api>[]
      if (preset.oauthProviderId && provider.oauthCredentials) {
        const oauthProv = getOAuthProvider(preset.oauthProviderId)
        if (oauthProv?.modifyModels) {
          const creds = storedToOAuthCredentials(provider.oauthCredentials)
          models = oauthProv.modifyModels([...models], creds) as Model<Api>[]
        }
      }

      const piModel = models.find(m => m.id === id)
      if (piModel) {
        // For Anthropic OAuth, inject the Claude Code CLI user-agent header
        if (provider.providerType === 'anthropic-oauth') {
          return {
            ...piModel,
            headers: {
              ...piModel.headers,
              'user-agent': `claude-cli/${CLAUDE_CODE_VERSION}`,
            },
          }
        }
        return piModel
      }
    } catch {
      // Fall through to generic build
    }
  }

  // Generic build for API key providers or fallback.
  // Resolution for per-model metadata: provider.models (user override) → local
  // PROVIDER_TYPE_MODEL_OVERRIDES catalog → configured price table → zero.
  const modelConfig = provider.models?.find(m => m.id === id)
    ?? findOverrideModel(provider.providerType, id)
  const priceFallback = getConfiguredPriceTable()[id] ?? { input: 0, output: 0 }

  // For Anthropic providers, set the user-agent header to advertise as Claude Code CLI
  const isAnthropicProvider = provider.providerType === 'anthropic' || provider.providerType === 'anthropic-oauth'
  const headers = isAnthropicProvider ? { 'user-agent': `claude-cli/${CLAUDE_CODE_VERSION}` } : undefined

  return {
    id,
    name: modelConfig?.name ?? id,
    api: provider.type as Api,
    provider: provider.provider,
    baseUrl: provider.baseUrl,
    reasoning: modelConfig?.reasoning ?? false,
    input: ['text', 'image'],
    cost: {
      input: modelConfig?.cost?.input ?? priceFallback.input,
      output: modelConfig?.cost?.output ?? priceFallback.output,
      cacheRead: modelConfig?.cost?.cacheRead ?? 0,
      cacheWrite: modelConfig?.cost?.cacheWrite ?? 0,
    },
    contextWindow: modelConfig?.contextWindow ?? 128000,
    maxTokens: modelConfig?.maxTokens ?? 16384,
    ...(headers && { headers }),
  }
}

/**
 * Parse a composite provider:model ID string into its parts.
 * Supports formats:
 *   - "providerId:modelId" → { providerId, modelId }
 *   - "providerId"         → { providerId, modelId: undefined }
 *   - "" / undefined        → { providerId: '', modelId: undefined }
 *
 * When modelId is undefined, callers should fall back to the provider's defaultModel.
 */
export function parseProviderModelId(value?: string): { providerId: string; modelId?: string } {
  if (!value) return { providerId: '' }
  const colonIdx = value.indexOf(':')
  if (colonIdx === -1) return { providerId: value }
  return {
    providerId: value.slice(0, colonIdx),
    modelId: value.slice(colonIdx + 1) || undefined,
  }
}

/**
 * Resolve a composite provider:model ID to a provider config and model.
 * Returns null if the provider is not found.
 */
export function resolveProviderModelId(value?: string): {
  provider: ProviderConfig
  modelId?: string
} | null {
  const { providerId, modelId } = parseProviderModelId(value)
  if (!providerId) return null
  const file = loadProvidersDecrypted()
  const provider = file.providers.find(p => p.id === providerId)
  if (!provider) return null
  return { provider, modelId }
}

/**
 * Resolve a user-friendly `(provider, model)` pair into a concrete provider
 * and model id. Used by agent tools like `create_cronjob`, `edit_cronjob`,
 * and `create_task` where the user may specify any combination of:
 *
 *   - both provider + model   → validate the model is enabled for that provider
 *   - provider only           → use the provider's default model
 *   - model only              → search providers for one whose enabledModels (or
 *                               defaultModel) contains the model; unique match wins
 *   - neither                 → `{ ok: false, error: 'none-specified' }`
 *
 * Provider lookup is case-insensitive on both `id` and `name`, matching the
 * pattern used by `resolveProvider` in runtime-composition.
 */
export function resolveProviderModelInput(input: {
  provider?: string | null
  model?: string | null
}): { ok: true; providerId: string; providerName: string; modelId: string; composite: string } | { ok: false; error: string } {
  const providerKey = input.provider?.trim() || ''
  const modelKey = input.model?.trim() || ''

  if (!providerKey && !modelKey) {
    return { ok: false, error: 'No provider or model specified.' }
  }

  const providers = loadProvidersDecrypted().providers

  // Case 1 & 2: provider (with or without model) given
  if (providerKey) {
    const match = providers.find(
      p => p.id === providerKey || p.name.toLowerCase() === providerKey.toLowerCase(),
    )
    if (!match) {
      return { ok: false, error: `Provider "${providerKey}" not found. Available providers: ${providers.map(p => p.name).join(', ') || '(none)'}.` }
    }

    const enabledModels = match.enabledModels && match.enabledModels.length > 0
      ? match.enabledModels
      : [match.defaultModel]

    let modelId: string
    if (modelKey) {
      const modelMatch = enabledModels.find(m => m.toLowerCase() === modelKey.toLowerCase())
      if (!modelMatch) {
        return { ok: false, error: `Model "${modelKey}" is not enabled for provider "${match.name}". Enabled models: ${enabledModels.join(', ')}.` }
      }
      modelId = modelMatch
    } else {
      modelId = match.defaultModel
    }

    return { ok: true, providerId: match.id, providerName: match.name, modelId, composite: `${match.id}:${modelId}` }
  }

  // Case 3: model only — search all providers for any enabled model that matches
  const hits: Array<{ provider: ProviderConfig; modelId: string }> = []
  for (const p of providers) {
    const enabledModels = p.enabledModels && p.enabledModels.length > 0
      ? p.enabledModels
      : [p.defaultModel]
    const modelMatch = enabledModels.find(m => m.toLowerCase() === modelKey.toLowerCase())
    if (modelMatch) hits.push({ provider: p, modelId: modelMatch })
  }

  if (hits.length === 0) {
    return { ok: false, error: `Model "${modelKey}" not found in any configured provider. Configured providers: ${providers.map(p => `${p.name} (${(p.enabledModels && p.enabledModels.length > 0 ? p.enabledModels : [p.defaultModel]).join(', ')})`).join('; ') || '(none)'}.` }
  }
  if (hits.length > 1) {
    return { ok: false, error: `Model "${modelKey}" is ambiguous — enabled in multiple providers: ${hits.map(h => h.provider.name).join(', ')}. Specify the provider explicitly.` }
  }

  const { provider: match, modelId } = hits[0]!
  return { ok: true, providerId: match.id, providerName: match.name, modelId, composite: `${match.id}:${modelId}` }
}

/**
 * Estimate cost from token counts using price table or model cost data
 */
export function estimateCost(
  model: Model<Api>,
  promptTokens: number,
  completionTokens: number,
  cacheReadTokens: number = 0,
  cacheWriteTokens: number = 0,
): number {
  // Model cost is per million tokens
  const inputCost = (promptTokens / 1_000_000) * model.cost.input
  const outputCost = (completionTokens / 1_000_000) * model.cost.output
  const cacheReadCost = (cacheReadTokens / 1_000_000) * model.cost.cacheRead
  const cacheWriteCost = (cacheWriteTokens / 1_000_000) * model.cost.cacheWrite
  return inputCost + outputCost + cacheReadCost + cacheWriteCost
}
