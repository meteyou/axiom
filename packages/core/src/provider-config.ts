import fs from 'node:fs'
import path from 'node:path'
import type { Api, Model } from '@mariozechner/pi-ai'
import { getConfigDir } from './config.js'

/**
 * Provider configuration as stored in providers.json
 */
export interface ProviderConfig {
  name: string
  type: string // e.g., 'openai-completions', 'anthropic-messages'
  provider: string // e.g., 'openai', 'anthropic', 'xai'
  baseUrl: string
  apiKey: string
  defaultModel: string
  models?: ProviderModelConfig[]
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
 * Get the active provider configuration
 */
export function getActiveProvider(): ProviderConfig | null {
  const file = loadProviders()
  if (file.providers.length === 0) return null

  if (file.activeProvider) {
    const found = file.providers.find(p => p.name === file.activeProvider)
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
