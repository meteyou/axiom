export interface ProviderModelSource {
  id: string
  name: string
  enabledModels?: string[]
  enabledImageModels?: string[]
  disabled?: boolean
  disabledModels?: string[]
  models?: { id: string; name?: string; description?: string }[]
  modelSpecs?: Record<string, { name?: string }>
  imageModelSpecs?: Record<string, { name?: string }>
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

export function getImageModelDisplayName(provider: Pick<ProviderModelSource, 'models' | 'imageModelSpecs'> | undefined, modelId: string): string {
  return provider?.models?.find(m => m.id === modelId)?.name?.trim()
    || provider?.imageModelSpecs?.[modelId]?.name?.trim()
    || modelId
}

export interface ImageModelOverviewEntry {
  providerId: string
  providerName: string
  modelId: string
  displayName: string
  description: string
}

/** Image models the agent can use: enabled image models of enabled providers. */
export function listUsableImageModels(providers: ProviderModelSource[]): ImageModelOverviewEntry[] {
  return providers
    .filter(provider => !provider.disabled)
    .flatMap(provider =>
      (provider.enabledImageModels ?? []).map(modelId => ({
        providerId: provider.id,
        providerName: provider.name,
        modelId,
        displayName: getImageModelDisplayName(provider, modelId),
        description: provider.models?.find(m => m.id === modelId)?.description?.trim() ?? '',
      })),
    )
}

/** `providerId:modelId` options for the default image model; image models never appear in text-model pickers. */
export function buildImageModelOptions(providers: ProviderModelSource[]): ProviderModelOption[] {
  return listUsableImageModels(providers).map(entry => ({
    value: `${entry.providerId}:${entry.modelId}`,
    label: `${entry.providerName} (${entry.displayName})`,
  }))
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
