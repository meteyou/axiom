import type { AvailableModelContract, ProviderModelUpdatePayloadContract } from '@axiom/core/contracts'

/**
 * Build the per-model override patch for a model taken from a live provider
 * catalog. Returns null when the entry carries no metadata worth persisting.
 */
export function buildCatalogModelPatch(entry: AvailableModelContract): ProviderModelUpdatePayloadContract | null {
  const patch: ProviderModelUpdatePayloadContract = {}
  if (entry.name && entry.name !== entry.id) patch.name = entry.name
  if (entry.contextWindow) patch.contextWindow = entry.contextWindow
  if (entry.maxTokens) patch.maxTokens = entry.maxTokens
  if (entry.cost) {
    const { input, output, cacheRead, cacheWrite } = entry.cost
    patch.cost = {
      input,
      output,
      ...(cacheRead !== undefined ? { cacheRead } : {}),
      ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    }
  }
  return Object.keys(patch).length > 0 ? patch : null
}
