import type { ImageApi, ImageModel } from '@earendil-works/pi-ai'
import { getBuiltinImageModels } from '@earendil-works/pi-ai/providers/all'
import type { BuiltinProvider } from '@earendil-works/pi-ai/providers/all'
import { SUPPORTED_IMAGE_APIS } from './pi-models.js'

export type ImageModality = 'text' | 'image'

export interface AvailableImageModel {
  id: string
  name: string
  input: ImageModality[]
  output: ImageModality[]
}

/**
 * Image models pi-ai ships for a pi-ai provider, restricted to image APIs
 * Axiom can dispatch. Separate from the text catalog: an image model is only
 * usable through `generateImages()`, never as a chat model.
 */
export function getImageCatalogModels(piAiProvider: string | null | undefined): ImageModel<ImageApi>[] {
  if (!piAiProvider) return []
  let models: ImageModel<ImageApi>[]
  try {
    models = getBuiltinImageModels(piAiProvider as BuiltinProvider) as ImageModel<ImageApi>[]
  } catch {
    return []
  }
  return models.filter(model => SUPPORTED_IMAGE_APIS.has(model.api))
}

export function toAvailableImageModel(model: ImageModel<ImageApi>): AvailableImageModel {
  return {
    id: model.id,
    name: model.name,
    input: [...model.input],
    output: [...model.output],
  }
}
