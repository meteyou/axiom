import type { ImageApi, ImageModel } from '@earendil-works/pi-ai'
import { getBuiltinImageModels } from '@earendil-works/pi-ai/providers/all'
import type { BuiltinProvider } from '@earendil-works/pi-ai/providers/all'
import { SUPPORTED_IMAGE_APIS } from './pi-models.js'
import {
  OPENAI_CODEX_IMAGES_API,
  OPENAI_CODEX_IMAGES_BASE_URL,
  OPENAI_IMAGES_API,
  OPENAI_IMAGES_BASE_URL,
} from './openai-images-api.js'

export type ImageModality = 'text' | 'image'

/** USD per 1M tokens. */
export interface ImageModelPricing {
  textInput: number
  imageInput: number
  imageOutput: number
  textOutput?: number
}

export interface AvailableImageModel {
  id: string
  name: string
  input: ImageModality[]
  output: ImageModality[]
  /** Token list prices, for providers that bill per token without reporting the amount. */
  pricing?: ImageModelPricing
}

export interface OpenAIImageModelInfo {
  id: string
  name: string
  pricing: ImageModelPricing
  /**
   * `flexible`: any `WIDTHxHEIGHT` within the GPT Image 2 constraints.
   * `fixed`: only 1024x1024, 1536x1024 and 1024x1536.
   */
  sizes: 'flexible' | 'fixed'
  transparentBackground: boolean
}

// OpenAI list prices (developers.openai.com/api/docs/pricing, October 2026).
// The API reports tokens only, so generation costs are estimated from these.
const OPENAI_IMAGE_MODELS: OpenAIImageModelInfo[] = [
  { id: 'gpt-image-2.5-flare', name: 'GPT Image 2.5 Flare', pricing: { textInput: 5, imageInput: 8, imageOutput: 30 }, sizes: 'flexible', transparentBackground: true },
  { id: 'gpt-image-2.5-sunburst', name: 'GPT Image 2.5 Sunburst', pricing: { textInput: 5, imageInput: 8, imageOutput: 30 }, sizes: 'flexible', transparentBackground: true },
  { id: 'gpt-image-2', name: 'GPT Image 2', pricing: { textInput: 5, imageInput: 8, imageOutput: 30 }, sizes: 'flexible', transparentBackground: false },
  { id: 'gpt-image-1.5', name: 'GPT Image 1.5', pricing: { textInput: 5, imageInput: 8, imageOutput: 32, textOutput: 10 }, sizes: 'fixed', transparentBackground: true },
  { id: 'gpt-image-1', name: 'GPT Image 1', pricing: { textInput: 5, imageInput: 10, imageOutput: 40 }, sizes: 'fixed', transparentBackground: true },
  { id: 'gpt-image-1-mini', name: 'GPT Image 1 Mini', pricing: { textInput: 2, imageInput: 2.5, imageOutput: 8 }, sizes: 'fixed', transparentBackground: true },
]

const DATED_SNAPSHOT_SUFFIX = /-\d{4}-\d{2}-\d{2}$/

/** Catalog details for an OpenAI image model id; dated snapshots resolve to their base model. */
export function findOpenAIImageModelInfo(modelId: string): OpenAIImageModelInfo | undefined {
  return OPENAI_IMAGE_MODELS.find(model => model.id === modelId)
    ?? OPENAI_IMAGE_MODELS.find(model => model.id === modelId.replace(DATED_SNAPSHOT_SUFFIX, ''))
}

/** Display name; a dated snapshot gets its base model's name plus the date. */
export function openAIImageModelName(modelId: string): string {
  const info = findOpenAIImageModelInfo(modelId)
  if (!info) return modelId
  return info.id === modelId ? info.name : `${info.name} (${modelId.slice(info.id.length + 1)})`
}

/** Catalog order (newest family first), each base model before its snapshots, unknown ids last. */
export function compareOpenAIImageModelIds(a: string, b: string): number {
  const rank = (id: string) => {
    const info = findOpenAIImageModelInfo(id)
    return info ? OPENAI_IMAGE_MODELS.indexOf(info) : OPENAI_IMAGE_MODELS.length
  }
  return rank(a) - rank(b) || a.length - b.length || a.localeCompare(b)
}

function openAIImageModel(info: OpenAIImageModelInfo): ImageModel<ImageApi> {
  return {
    type: 'image',
    id: info.id,
    name: info.name,
    api: OPENAI_IMAGES_API,
    provider: 'openai',
    baseUrl: OPENAI_IMAGES_BASE_URL,
    input: ['text', 'image'],
    output: ['image'],
    cost: { input: info.pricing.textInput, output: info.pricing.imageOutput, cacheRead: 0, cacheWrite: 0 },
  }
}

/**
 * The ChatGPT backend ignores the requested model and picks the renderer
 * itself (any id, even an invalid one, is accepted), so a Codex login offers
 * exactly one image model. The id is the one the Codex CLI sends.
 */
const CODEX_IMAGE_MODEL: ImageModel<ImageApi> = {
  type: 'image',
  id: 'gpt-image-2',
  name: 'GPT Image (ChatGPT subscription)',
  api: OPENAI_CODEX_IMAGES_API,
  provider: 'openai-codex',
  baseUrl: OPENAI_CODEX_IMAGES_BASE_URL,
  input: ['text', 'image'],
  output: ['image'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}

/** Image models pi-ai does not ship, keyed by Axiom provider type. */
const LOCAL_IMAGE_CATALOGS: Record<string, ImageModel<ImageApi>[]> = {
  openai: OPENAI_IMAGE_MODELS.map(openAIImageModel),
  'openai-codex': [CODEX_IMAGE_MODEL],
}

function getBuiltinImageCatalog(piAiProvider: string | null | undefined): ImageModel<ImageApi>[] {
  if (!piAiProvider) return []
  try {
    return getBuiltinImageModels(piAiProvider as BuiltinProvider) as ImageModel<ImageApi>[]
  } catch {
    return []
  }
}

/**
 * Image models of a provider type: pi-ai's image catalog for its pi-ai
 * provider plus Axiom's own entries, restricted to image APIs Axiom can
 * dispatch. Separate from the text catalog: an image model is only usable
 * through `generateImages()`, never as a chat model.
 */
export function getImageCatalogModels(piAiProvider: string | null | undefined, providerType: string): ImageModel<ImageApi>[] {
  return [...getBuiltinImageCatalog(piAiProvider), ...(LOCAL_IMAGE_CATALOGS[providerType] ?? [])]
    .filter(model => SUPPORTED_IMAGE_APIS.has(model.api))
}

export function toAvailableImageModel(model: ImageModel<ImageApi>): AvailableImageModel {
  const pricing = model.api === OPENAI_IMAGES_API ? findOpenAIImageModelInfo(model.id)?.pricing : undefined
  return {
    id: model.id,
    name: model.name,
    input: [...model.input],
    output: [...model.output],
    ...(pricing && { pricing: { ...pricing } }),
  }
}
