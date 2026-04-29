import { buildModel, PROVIDER_TYPE_MODEL_OVERRIDES, PROVIDER_TYPE_PRESETS } from '@axiom/core'
import type {
  ProviderConfig,
  ProviderType,
  ProvidersFile,
} from '@axiom/core'
import type {
  OllamaModelContract,
  ProviderActivationResponseContract,
  ProviderContract,
  ProviderFallbackResponseContract,
  ProviderMutationResponseContract,
  ProvidersListResponseContract,
} from '@axiom/core/contracts'
import { getModels as getPiAiModels } from '@mariozechner/pi-ai'
import type { KnownProvider as PiAiKnownProvider } from '@mariozechner/pi-ai'
import type { OllamaTagsResponse } from './types.js'

function maskApiKey(apiKey: string): string {
  return `${apiKey.slice(0, 4)}••••••••${apiKey.slice(-4)}`
}

function resolveModelCost(provider: ProviderConfig, modelId: string): { input: number; output: number } | null {
  try {
    const model = buildModel(provider, modelId)
    if (model.cost.input > 0 || model.cost.output > 0) {
      return { input: model.cost.input, output: model.cost.output }
    }
  } catch {
    // ignore and try registry fallback
  }

  const preset = PROVIDER_TYPE_PRESETS[provider.providerType as ProviderType]
  if (!preset?.piAiProvider) {
    return null
  }

  try {
    const models = getPiAiModels(preset.piAiProvider as PiAiKnownProvider)
    const match = models.find((entry) => entry.id === modelId)
    if (match && (match.cost.input > 0 || match.cost.output > 0)) {
      return { input: match.cost.input, output: match.cost.output }
    }
  } catch {
    // ignore lookup errors
  }

  return null
}

export function mapProvidersListResponse(masked: ProvidersFile, decrypted: ProvidersFile): ProvidersListResponseContract {
  const providers = masked.providers.map((provider) => {
    const fullProvider = decrypted.providers.find((candidate) => candidate.id === provider.id)
    let cost: { input: number; output: number } | null = null
    const modelCosts: Record<string, { input: number; output: number }> = {}

    if (fullProvider) {
      cost = resolveModelCost(fullProvider, fullProvider.defaultModel)

      const enabledModels = fullProvider.enabledModels ?? [fullProvider.defaultModel]
      for (const modelId of enabledModels) {
        const modelCost = resolveModelCost(fullProvider, modelId)
        if (modelCost) {
          modelCosts[modelId] = modelCost
        }
      }
    }

    return {
      ...provider,
      apiKeyMasked: (provider as unknown as { apiKeyMasked?: string }).apiKeyMasked ?? provider.apiKey,
      cost,
      modelCosts,
    } as ProviderContract
  })

  const presets = Object.fromEntries(
    Object.entries(PROVIDER_TYPE_PRESETS)
      .filter(([key]) => key !== 'ollama-local' && key !== 'ollama-cloud')
      .map(([key, preset]) => {
        const overrides = PROVIDER_TYPE_MODEL_OVERRIDES[key as ProviderType]
        const hasKnownModels = preset.piAiProvider != null || (overrides?.length ?? 0) > 0
        return [key, { ...preset, hasKnownModels }]
      }),
  )

  return {
    providers,
    activeProvider: masked.activeProvider ?? null,
    activeModel: masked.activeModel ?? null,
    fallbackProvider: masked.fallbackProvider ?? null,
    fallbackModel: masked.fallbackModel ?? null,
    presets,
  }
}

export function mapCreatedProviderResponse(provider: ProviderConfig, rawApiKey?: string): ProviderMutationResponseContract {
  return {
    provider: {
      ...provider,
      apiKey: '',
      apiKeyMasked: rawApiKey ? maskApiKey(rawApiKey) : '',
    } as ProviderContract,
  }
}

export function mapUpdatedProviderResponse(provider: ProviderConfig, rawApiKey?: string): ProviderMutationResponseContract {
  return {
    provider: {
      ...provider,
      apiKey: '',
      apiKeyMasked: rawApiKey ? maskApiKey(rawApiKey) : '(unchanged)',
    } as ProviderContract,
  }
}

export function mapOAuthProviderResponse(provider: ProviderConfig): ProviderMutationResponseContract {
  return {
    provider: {
      ...provider,
      apiKey: '',
      apiKeyMasked: '',
    } as ProviderContract,
  }
}

export function mapProviderActivationResponse(
  activeProvider: string,
  activeModel: string | null,
): ProviderActivationResponseContract & { message: string } {
  return {
    message: 'Provider activated',
    activeProvider,
    activeModel,
  }
}

export function mapFallbackSetResponse(
  fallbackProvider: string | null,
  fallbackModel: string | null,
): ProviderFallbackResponseContract & { message: string } {
  return {
    message: fallbackProvider ? 'Fallback set' : 'Fallback provider cleared',
    fallbackProvider,
    fallbackModel,
  }
}

export function mapOllamaModelsResponse(data: OllamaTagsResponse): { models: OllamaModelContract[] } {
  const models: OllamaModelContract[] = (data.models ?? []).map((entry) => ({
    name: entry.name,
    size: entry.size,
    parameterSize: entry.details?.parameter_size ?? '',
    quantization: entry.details?.quantization_level ?? '',
    family: entry.details?.family ?? '',
  }))

  return { models }
}
