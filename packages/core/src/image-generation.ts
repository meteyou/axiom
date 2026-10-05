import type { AssistantImages, FetchFunction, ImageApi, ImageContent, ImageModel, ImagesInputContent } from '@earendil-works/pi-ai'
import { ensureConfigTemplates, loadConfig, warnConfigReadFailed } from './config.js'
import { IMAGE_GENERATION_MAX_VARIANTS_BOUNDS, normalizeImageGenerationSettings } from './contracts/settings.js'
import type { ImageGenerationSettingsContract } from './contracts/settings.js'
import { getImageBackend, requireImageBackend } from './image-backends.js'
import type { ImageBilling, ImageGenerationParameters } from './image-backends.js'
import type { AvailableImageModel } from './image-catalog.js'
import { generateImages } from './pi-models.js'
import {
  buildImageModel,
  getApiKeyForProvider,
  getAvailableImageModels,
  getImageApiForType,
  getImageBaseUrl,
  getUsableImageModels,
  loadProvidersDecrypted,
} from './provider-config.js'
import type { ProviderConfig, ProviderType } from './provider-config.js'

export type { ImageBilling, ImageGenerationParameters } from './image-backends.js'

/** Slow models (e.g. GPT-5 Image) take well over a minute for a single image. */
const IMAGE_GENERATION_TIMEOUT_MS = 180_000
const AVAILABILITY_TIMEOUT_MS = 15_000
const MODEL_LIST_TIMEOUT_MS = 15_000

/** Fixed prompt for the "Generate test image" action in the Providers UI. */
export const IMAGE_TEST_PROMPT = 'A small red apple on a plain white background, simple flat illustration.'

export interface ImageProviderCapabilities {
  billing: ImageBilling
  /** The provider lists its image models live; otherwise only the bundled catalog is offered. */
  liveCatalog: boolean
  customModels: boolean
}

/** Image generation traits of a provider type, `null` when it serves no image models. */
export function getImageProviderCapabilities(providerType: ProviderType | string): ImageProviderCapabilities | null {
  const api = getImageApiForType(providerType)
  const backend = api ? getImageBackend(api) : undefined
  if (!backend) return null
  return { billing: backend.billing, liveCatalog: Boolean(backend.listModels), customModels: backend.customModels }
}

/**
 * Image models the provider offers right now. Providers without a live list
 * return the bundled catalog; failures propagate so callers can fall back.
 */
export async function listLiveImageModels(
  provider: ProviderConfig,
  options: { fetchImpl?: FetchFunction; timeoutMs?: number } = {},
): Promise<AvailableImageModel[]> {
  const api = getImageApiForType(provider.providerType)
  const baseUrl = getImageBaseUrl(provider)
  if (!api || !baseUrl) throw new Error(`Provider "${provider.name}" does not support image generation`)
  const backend = requireImageBackend(api)
  if (!backend.listModels) return getAvailableImageModels(provider.providerType)
  const apiKey = await getApiKeyForProvider(provider)
  return backend.listModels(baseUrl, apiKey, options.fetchImpl ?? fetch, AbortSignal.timeout(options.timeoutMs ?? MODEL_LIST_TIMEOUT_MS))
}

export type ImageGenerationPlan =
  | { ok: true; billing: ImageBilling; notes: string[] }
  | { ok: false; error: string }

/**
 * Checks a request against the model before anything is sent: input images
 * and parameters the model cannot handle are rejected up front instead of
 * failing (and possibly being billed) at the provider.
 */
export function planImageGeneration(
  provider: ProviderConfig,
  modelId: string,
  parameters: ImageGenerationParameters,
  inputImageCount: number,
): ImageGenerationPlan {
  const model = buildImageModel(provider, modelId)
  const backend = requireImageBackend(model.api)
  if (inputImageCount > 0 && !model.input.includes('image')) {
    return { ok: false, error: `Model "${modelId}" does not accept input images. Choose a model that supports image editing.` }
  }
  if (inputImageCount > backend.maxInputImages) {
    return { ok: false, error: `Model "${modelId}" accepts at most ${backend.maxInputImages} input images.` }
  }
  const prepared = backend.prepare(model, parameters)
  if (!prepared.ok) return prepared
  return { ok: true, billing: backend.billing, notes: prepared.notes }
}

export interface ImageModelAvailabilityResult {
  status: 'healthy' | 'degraded' | 'down'
  latencyMs: number | null
  errorMessage?: string
}

/**
 * Free availability check for an image model. Image models cannot answer the
 * chat-based connection test, and a real generation costs money.
 */
export async function checkImageModelAvailability(
  provider: ProviderConfig,
  modelId: string,
  options: { fetchImpl?: FetchFunction; timeoutMs?: number } = {},
): Promise<ImageModelAvailabilityResult> {
  const startedAt = Date.now()
  try {
    const model = buildImageModel(provider, modelId)
    const apiKey = await getApiKeyForProvider(provider)
    const result = await requireImageBackend(model.api).checkAvailability(
      model,
      apiKey,
      options.fetchImpl ?? fetch,
      AbortSignal.timeout(options.timeoutMs ?? AVAILABILITY_TIMEOUT_MS),
    )
    const latencyMs = Date.now() - startedAt
    if (!result.ok) return { status: 'down', latencyMs, errorMessage: result.error }
    const degraded = latencyMs > (provider.degradedThresholdMs ?? 5000)
    return { status: degraded ? 'degraded' : 'healthy', latencyMs }
  } catch (err) {
    return { status: 'down', latencyMs: null, errorMessage: (err as Error).message }
  }
}

export interface GeneratedImage {
  mimeType: string
  /** Base64 payload. Must never be handed to the model context. */
  data: string
  generationId?: string
  costUsd?: number
}

export interface ImageGenerationRequest {
  provider: ProviderConfig
  modelId: string
  prompt: string
  inputImages?: ImageContent[]
  parameters?: ImageGenerationParameters
  /** Number of images; each one is a separate request, run in parallel. */
  count?: number
  signal?: AbortSignal
  timeoutMs?: number
  /** Test seam for the pi-ai call. */
  generate?: typeof generateImages
  /** Test seam for the HTTP layer underneath pi-ai. */
  fetchImpl?: FetchFunction
}

export interface ImageRequestOutcome {
  /** Billed cost the provider reported for this request, `null` when none was reported. */
  costUsd: number | null
  usage: ImageGenerationUsage
}

export interface ImageGenerationUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface ImageGenerationResult {
  model: ImageModel<ImageApi>
  images: GeneratedImage[]
  /** Text the model returned alongside (or instead of) images, e.g. a refusal. */
  texts: string[]
  /** Sum of the per-request costs (see `billing`); `null` when none were known. */
  costUsd: number | null
  billing: ImageBilling
  usage: ImageGenerationUsage
  /** One entry per provider request (one per variant), so costs can be booked per image. */
  requests: ImageRequestOutcome[]
  durationMs: number
  errors: string[]
  /** Parameter adjustments, e.g. an aspect ratio mapped to the closest supported size. */
  notes: string[]
  /** Usage-limit summary from the last response, for subscription billing. */
  usageNote?: string
}

async function readJsonSafely(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

const NO_IMAGE_RETURNED = 'The model returned no image. It may have refused the prompt, or answered with a remote image URL, which is not supported.'

async function runWithConcurrency<T>(count: number, limit: number, task: () => Promise<T>): Promise<T[]> {
  const results: T[] = []
  let next = 0
  const worker = async () => {
    while (next < count) {
      const index = next++
      results[index] = await task()
    }
  }
  await Promise.all(Array.from({ length: Math.min(count, limit) }, worker))
  return results
}

export async function generateImagesWithProvider(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
  const model = buildImageModel(request.provider, request.modelId)
  const backend = requireImageBackend(model.api)
  const prepared = backend.prepare(model, request.parameters ?? {})
  if (!prepared.ok) throw new Error(prepared.error)
  const apiKey = await getApiKeyForProvider(request.provider)
  const generate = request.generate ?? generateImages
  const fetchImpl = request.fetchImpl ?? fetch
  const count = Math.min(Math.max(1, Math.floor(request.count ?? 1)), IMAGE_GENERATION_MAX_VARIANTS_BOUNDS.max)
  const input: ImagesInputContent[] = [{ type: 'text', text: request.prompt }, ...(request.inputImages ?? [])]
  const startedAt = Date.now()
  let usageNote: string | undefined

  const runOne = async () => {
    let reportedCost: number | undefined
    // Only the cost is kept from the raw body; it also carries the base64
    // images and, for Gemini, a ~1 MB reasoning signature.
    const fetchCapturingCost: FetchFunction = async (url, init) => {
      const response = await fetchImpl(url, init)
      if (response.ok) reportedCost = backend.extractCost(await readJsonSafely(response.clone()), model)
      return response
    }
    const result = await generate(model, { input }, {
      apiKey,
      fetch: fetchCapturingCost,
      timeoutMs: request.timeoutMs ?? IMAGE_GENERATION_TIMEOUT_MS,
      maxRetries: 0,
      signal: request.signal,
      onPayload: payload => ({ ...(payload as Record<string, unknown>), ...prepared.payload }),
      onResponse: (response) => {
        usageNote = backend.describeUsage?.(response.headers) ?? usageNote
      },
    })
    return { result, reportedCost }
  }

  const outcomes = await runWithConcurrency(count, backend.maxParallel, runOne)
  return {
    model,
    ...collectOutcomes(outcomes),
    billing: backend.billing,
    durationMs: Date.now() - startedAt,
    notes: prepared.notes,
    ...(usageNote && { usageNote }),
  }
}

interface RequestOutcome {
  result: AssistantImages
  reportedCost: number | undefined
}

function collectOutcomes(outcomes: RequestOutcome[]): Pick<ImageGenerationResult, 'images' | 'texts' | 'costUsd' | 'usage' | 'requests' | 'errors'> {
  const images: GeneratedImage[] = []
  const texts: string[] = []
  const errors: string[] = []
  const usage: ImageGenerationUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  const requests: ImageRequestOutcome[] = []
  let costUsd: number | null = null

  for (const { result, reportedCost } of outcomes) {
    if (reportedCost !== undefined) costUsd = (costUsd ?? 0) + reportedCost
    const requestUsage: ImageGenerationUsage = {
      input: result.usage?.input ?? 0,
      output: result.usage?.output ?? 0,
      cacheRead: result.usage?.cacheRead ?? 0,
      cacheWrite: result.usage?.cacheWrite ?? 0,
    }
    usage.input += requestUsage.input
    usage.output += requestUsage.output
    usage.cacheRead += requestUsage.cacheRead
    usage.cacheWrite += requestUsage.cacheWrite
    requests.push({ costUsd: reportedCost ?? null, usage: requestUsage })
    if (result.stopReason !== 'stop') {
      errors.push(result.errorMessage || (result.stopReason === 'aborted' ? 'Image generation was aborted' : 'Image generation failed'))
      continue
    }

    const produced = result.output.filter((part): part is ImageContent => part.type === 'image')
    for (const part of result.output) {
      if (part.type === 'text' && part.text.trim()) texts.push(part.text.trim())
    }
    if (produced.length === 0) {
      errors.push(NO_IMAGE_RETURNED)
      continue
    }
    for (const [index, image] of produced.entries()) {
      images.push({
        mimeType: image.mimeType,
        data: image.data,
        generationId: result.responseId,
        // The billed cost belongs to the request, so it is attributed to its first image.
        costUsd: index === 0 ? reportedCost : undefined,
      })
    }
  }

  return { images, texts, costUsd, usage, requests, errors }
}

export interface UsableImageModel {
  provider: ProviderConfig
  modelId: string
}

function listUsableImageModels(providers: ProviderConfig[] = loadProvidersDecrypted().providers): UsableImageModel[] {
  return providers.flatMap(provider => getUsableImageModels(provider).map(modelId => ({ provider, modelId })))
}

/** `settings.json → imageGeneration`, with defaults for missing or invalid values. Throws when `settings.json` cannot be read. */
export function readImageGenerationSettings(): ImageGenerationSettingsContract {
  ensureConfigTemplates()
  const settings = loadConfig<{ imageGeneration?: Partial<ImageGenerationSettingsContract> }>('settings.json')
  return normalizeImageGenerationSettings(settings.imageGeneration)
}

interface ActiveImageGeneration {
  settings: ImageGenerationSettingsContract
  entries: UsableImageModel[]
}

/**
 * Settings and usable image models while `generate_image` is offered: image
 * generation is switched on and at least one image model is usable. Tool
 * registration and the prompt's model list both derive from this.
 */
export function loadActiveImageGeneration(): ActiveImageGeneration | undefined {
  let settings: ImageGenerationSettingsContract
  try {
    settings = readImageGenerationSettings()
  } catch (err) {
    // Fail closed: an unreadable settings.json must not re-enable a paid tool the user switched off.
    warnConfigReadFailed('settings.json', err, 'image generation disabled')
    return undefined
  }
  if (!settings.enabled) return undefined
  const entries = listUsableImageModels()
  return entries.length > 0 ? { settings, entries } : undefined
}

export function isImageGenerationAvailable(): boolean {
  return loadActiveImageGeneration() !== undefined
}

function toRef(entry: UsableImageModel): string {
  return `${entry.provider.id}:${entry.modelId}`
}

function describeImageModels(entries: UsableImageModel[]): string {
  return entries.map(entry => `${entry.provider.name}: ${entry.modelId}`).join(', ')
}

/**
 * The default image model: the Settings choice when it is still usable,
 * otherwise the first usable image model.
 */
export function resolveDefaultImageModel(entries: UsableImageModel[], defaultRef: string): UsableImageModel | undefined {
  return entries.find(entry => toRef(entry) === defaultRef) ?? entries[0]
}

export type ImageModelResolution =
  | ({ ok: true } & UsableImageModel)
  | { ok: false; error: string }

/**
 * Resolve the `model` argument of `generate_image`: `providerId:modelId`,
 * `providerName:modelId` or a bare model id (unique across providers). An
 * empty value selects the default image model.
 */
export function resolveImageModel(
  requested: string | undefined,
  entries: UsableImageModel[] = listUsableImageModels(),
  defaultRef: string = readImageGenerationSettings().defaultModel,
): ImageModelResolution {
  if (entries.length === 0) {
    return { ok: false, error: 'No image generation model is enabled. Enable one under Providers → Image models.' }
  }

  const key = requested?.trim()
  if (!key) return { ok: true, ...resolveDefaultImageModel(entries, defaultRef)! }

  const lowerKey = key.toLowerCase()
  const composite = entries.find(entry =>
    toRef(entry) === key || `${entry.provider.name}:${entry.modelId}`.toLowerCase() === lowerKey,
  )
  if (composite) return { ok: true, ...composite }

  const byModelId = entries.filter(entry => entry.modelId.toLowerCase() === lowerKey)
  if (byModelId.length === 1) return { ok: true, ...byModelId[0]! }
  if (byModelId.length > 1) {
    return {
      ok: false,
      error: `Image model "${key}" is enabled for several providers (${byModelId.map(e => e.provider.name).join(', ')}). Pass it as "<provider>:<model>".`,
    }
  }
  return { ok: false, error: `Image model "${key}" is not enabled. Available image models: ${describeImageModels(entries)}.` }
}
