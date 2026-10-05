import type {
  AvailableImageModelContract,
  ProviderModelUpdatePayloadContract,
} from '@axiom/core/contracts'
import { formatModelCost } from './modelFormat'

/**
 * Overrides for an image model taken from a live provider list. Models newer
 * than the bundled catalog are otherwise built with default modalities, which
 * breaks text-and-image models and allows input images where none are accepted.
 * The output price is kept as the model's cost so the Providers page can show it.
 */
export function buildImageCatalogModelPatch(entry: AvailableImageModelContract): ProviderModelUpdatePayloadContract {
  return {
    ...(entry.name && entry.name !== entry.id && { name: entry.name }),
    input: [...entry.input],
    output: [...entry.output],
    ...(entry.pricing && { cost: { output: entry.pricing.imageOutput } }),
  }
}

/** Price per 1M output tokens, e.g. `$30.00 / 1M`. */
export function formatPerMillionPrice(usdPerMillion: number): string {
  return `$${formatModelCost(usdPerMillion)} / 1M`
}

/** Cost of a single image: `$0.035`, `$0.12`. */
export function formatImageCost(usd: number): string {
  return `$${usd >= 0.1 ? usd.toFixed(2) : usd.toFixed(3)}`
}
