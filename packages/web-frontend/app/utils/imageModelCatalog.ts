import type {
  AvailableImageModelContract,
  ImageModelPricingContract,
  ProviderModelUpdatePayloadContract,
} from '@axiom/core/contracts'
import { formatModelCost } from './modelFormat'

/**
 * Overrides for an image model taken from a live provider list. Models newer
 * than the bundled catalog are otherwise built with default modalities, which
 * breaks text-and-image models and allows input images where none are accepted.
 */
export function buildImageCatalogModelPatch(entry: AvailableImageModelContract): ProviderModelUpdatePayloadContract {
  return {
    ...(entry.name && entry.name !== entry.id && { name: entry.name }),
    input: [...entry.input],
    output: [...entry.output],
  }
}

/** Image output list price, e.g. `$30 / 1M`. */
export function formatImageOutputPrice(pricing: ImageModelPricingContract): string {
  return `$${formatModelCost(pricing.imageOutput)} / 1M`
}
