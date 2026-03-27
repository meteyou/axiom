import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { Api, Model } from '@mariozechner/pi-ai'
import { getConfigDir } from './config.js'
import { encrypt, decrypt, isEncrypted, maskApiKey } from './encryption.js'

/**
 * Supported provider types with presets
 */
export type ProviderType = 'openai' | 'anthropic' | 'ollama-local' | 'ollama-cloud' | 'kimi' | 'zai'

export interface ProviderTypePreset {
  type: ProviderType
  label: string
  apiType: string // pi-ai API type
  providerName: string
  baseUrl: string
  requiresApiKey: boolean
}

export const PROVIDER_TYPE_PRESETS: Record<ProviderType, ProviderTypePreset> = {
  openai: {
    type: 'openai',
    label: 'OpenAI',
    apiType: 'openai-completions',
    providerName: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    requiresApiKey: true,
  },
  anthropic: {
    type: 'anthropic',
    label: 'Anthropic',
    apiType: 'anthropic-messages',
    providerName: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    requiresApiKey: true,
  },
  'ollama-local': {
    type: 'ollama-local',
    label: 'Ollama (Local)',
    apiType: 'openai-completions',
    providerName: 'ollama',
    baseUrl: 'http://localhost:11434/v1',
    requiresApiKey: false,
  },
  'ollama-cloud': {
    type: 'ollama-cloud',
    label: 'Ollama Cloud',
    apiType: 'openai-completions',
    providerName: 'ollama',
    baseUrl: '',
    requiresApiKey: true,
  },
  kimi: {
    type: 'kimi',
    label: 'Kimi / Moonshot',
    apiType: 'openai-completions',
    providerName: 'moonshot',
    baseUrl: 'https://api.moonshot.ai/v1',
    requiresApiKey: true,
  },
  zai: {
    type: 'zai',
    label: 'z.ai',
    apiType: 'openai-completions',
    providerName: 'zai',
    baseUrl: 'https://api.z.ai/v1',
    requiresApiKey: true,
  },
}

/**
 * Provider configuration as stored in providers.json
 */
export interface ProviderConfig {
  id: string
  name: string
  type: string // e.g., 'openai-completions', 'anthropic-messages'
  providerType: ProviderType // e.g., 'openai', 'anthropic', 'ollama-local'
  provider: string // e.g., 'openai', 'anthropic', 'xai'
  baseUrl: string
  apiKey: string // encrypted at rest
  defaultModel: string
  models?: ProviderModelConfig[]
  status?: 'connected' | 'error' | 'untested'
}

export interface ProviderModelConfig {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  reasoning?: boolean
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
  _comment?: string
}

/**
 * Price table for common models (cost per million tokens in USD)
 * Used as fallback when pi-mono cost data is not available
 */
export const DEFAULT_PRICE_TABLE: Record<string, { input: number; output: number }> = {
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
  return JSON.parse(content) as ProvidersFile
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
    providers: file.providers.map(p => ({
      ...p,
      apiKey: p.apiKey && isEncrypted(p.apiKey) ? decrypt(p.apiKey) : p.apiKey,
    })),
  }
}

/**
 * Get providers with API keys masked for display
 */
export function loadProvidersMasked(): ProvidersFile & { providers: (ProviderConfig & { apiKeyMasked: string })[] } {
  const file = loadProvidersDecrypted()
  return {
    ...file,
    providers: file.providers.map(p => ({
      ...p,
      apiKey: '', // Never send real key to frontend
      apiKeyMasked: p.apiKey ? maskApiKey(p.apiKey) : '',
    })),
  }
}

/**
 * Generate a unique provider ID
 */
function generateProviderId(): string {
  return crypto.randomUUID()
}

/**
 * Add a new provider
 */
export function addProvider(input: {
  name: string
  providerType: ProviderType
  baseUrl?: string
  apiKey?: string
  defaultModel: string
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

  const provider: ProviderConfig = {
    id: generateProviderId(),
    name: input.name,
    type: preset.apiType,
    providerType: input.providerType,
    provider: preset.providerName,
    baseUrl: input.baseUrl || preset.baseUrl,
    apiKey: input.apiKey ? encrypt(input.apiKey) : '',
    defaultModel: input.defaultModel,
    status: 'untested',
  }

  file.providers.push(provider)

  // If this is the first provider, make it active
  if (file.providers.length === 1) {
    file.activeProvider = provider.id
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
    if (!input.baseUrl) {
      existing.baseUrl = preset.baseUrl
    }
  }

  if (input.name !== undefined) existing.name = input.name
  if (input.baseUrl !== undefined) existing.baseUrl = input.baseUrl
  if (input.apiKey !== undefined) existing.apiKey = input.apiKey ? encrypt(input.apiKey) : ''
  if (input.defaultModel !== undefined) existing.defaultModel = input.defaultModel

  // Reset status when config changes
  existing.status = 'untested'

  file.providers[index] = existing
  saveProviders(file)
  return existing
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

  file.providers.splice(index, 1)
  saveProviders(file)
}

/**
 * Set the active provider
 */
export function setActiveProvider(id: string): void {
  const file = loadProviders()
  const provider = file.providers.find(p => p.id === id)
  if (!provider) {
    throw new Error(`Provider not found: ${id}`)
  }
  file.activeProvider = id
  saveProviders(file)
}

/**
 * Update a provider's status
 */
export function updateProviderStatus(id: string, status: 'connected' | 'error' | 'untested'): void {
  const file = loadProviders()
  const provider = file.providers.find(p => p.id === id)
  if (!provider) return
  provider.status = status
  saveProviders(file)
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
 * Build a pi-ai Model object from a provider config
 */
export function buildModel(provider: ProviderConfig, modelId?: string): Model<Api> {
  const id = modelId ?? provider.defaultModel
  const modelConfig = provider.models?.find(m => m.id === id)
  const priceFallback = DEFAULT_PRICE_TABLE[id] ?? { input: 0, output: 0 }

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
  }
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
