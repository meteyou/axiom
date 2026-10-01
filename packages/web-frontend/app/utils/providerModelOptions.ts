export interface ProviderModelSource {
  id: string
  name: string
  enabledModels?: string[]
  disabled?: boolean
  disabledModels?: string[]
  models?: { id: string; name?: string }[]
  modelSpecs?: Record<string, { name?: string }>
}

export interface ProviderModelOption {
  value: string
  label: string
}

/** Display name of a model: user override → catalog name → id. */
export function getModelDisplayName(provider: Pick<ProviderModelSource, 'models' | 'modelSpecs'> | undefined, modelId: string): string {
  return provider?.models?.find(m => m.id === modelId)?.name?.trim()
    || provider?.modelSpecs?.[modelId]?.name?.trim()
    || modelId
}

/**
 * Flattened `providerId:modelId` options for provider/model select dropdowns.
 * Disabled providers/models are skipped unless `includeDisabled` is set (STT
 * rewrite may still use them).
 */
export function buildProviderModelOptions(
  providers: ProviderModelSource[],
  { includeDisabled = false }: { includeDisabled?: boolean } = {},
): ProviderModelOption[] {
  return providers
    .filter(provider => includeDisabled || !provider.disabled)
    .flatMap(provider =>
      (provider.enabledModels ?? [])
        .filter(modelId => includeDisabled || !provider.disabledModels?.includes(modelId))
        .map(modelId => ({
          value: `${provider.id}:${modelId}`,
          label: `${provider.name} (${getModelDisplayName(provider, modelId)})`,
        })),
    )
}

/** Resolve a provider by id or (case-insensitive) display name. */
export function findProviderByKey<T extends ProviderModelSource>(providers: T[], key: string): T | undefined {
  const lowerKey = key.toLowerCase()
  return providers.find(p => p.id === key || p.name.toLowerCase() === lowerKey)
}
