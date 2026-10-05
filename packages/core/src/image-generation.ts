import type { FetchFunction, ImageApi, ImageContent, ImageModel, ImagesInputContent } from '@earendil-works/pi-ai'
import { ensureConfigTemplates, loadConfig } from './config.js'
import { IMAGE_GENERATION_MAX_VARIANTS_BOUNDS, normalizeImageGenerationSettings } from './contracts/settings.js'
import type { ImageGenerationSettingsContract } from './contracts/settings.js'
import { generateImages } from './pi-models.js'
import {
  buildImageModel,
  getApiKeyForProvider,
  getUsableImageModels,
  loadProviders,
  loadProvidersDecrypted,
} from './provider-config.js'
import type { ProviderConfig } from './provider-config.js'

/** Slow models (e.g. GPT-5 Image) take well over a minute for a single image. */
const IMAGE_GENERATION_TIMEOUT_MS = 180_000
const AVAILABILITY_TIMEOUT_MS = 15_000

/** Fixed prompt for the paid "Generate test image" action in the Providers UI. */
export const IMAGE_TEST_PROMPT = 'A small red apple on a plain white background, simple flat illustration.'

export interface ImageGenerationParameters {
  aspectRatio?: string
}

type ImageAvailability =
  | { ok: true }
  | { ok: false; error: string }

/**
 * Wire-level behaviour pi-ai does not cover for an image API: optional
 * request parameters, the real billed cost and a free availability probe.
 * Keyed by pi-ai `ImageApi` so further backends plug in next to OpenRouter.
 */
interface ImageBackend {
  applyParameters(payload: Record<string, unknown>, params: ImageGenerationParameters): Record<string, unknown>
  extractCost(rawResponse: unknown): number | undefined
  checkAvailability(model: ImageModel<ImageApi>, apiKey: string, fetchImpl: FetchFunction, signal: AbortSignal): Promise<ImageAvailability>
}

function encodeModelPath(modelId: string): string {
  return modelId.split('/').map(encodeURIComponent).join('/')
}

const openRouterImageBackend: ImageBackend = {
  // pi-ai sends no image options at all; OpenRouter reads them from `image_config`.
  applyParameters(payload, params) {
    if (!params.aspectRatio) return payload
    return { ...payload, image_config: { aspect_ratio: params.aspectRatio } }
  },

  // pi-ai prices image models from per-token catalog rates, which are zero or
  // far off for most image models. OpenRouter reports the billed amount here.
  extractCost(rawResponse) {
    const cost = (rawResponse as { usage?: { cost?: unknown } } | null)?.usage?.cost
    return typeof cost === 'number' && Number.isFinite(cost) ? cost : undefined
  },

  async checkAvailability(model, apiKey, fetchImpl, signal) {
    const baseUrl = model.baseUrl.replace(/\/+$/, '')
    const [endpointsResponse, keyResponse] = await Promise.all([
      fetchImpl(`${baseUrl}/models/${encodeModelPath(model.id)}/endpoints`, { headers: { Accept: 'application/json' }, signal }),
      fetchImpl(`${baseUrl}/key`, { headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` }, signal }),
    ])

    if (keyResponse.status === 401 || keyResponse.status === 403) {
      return { ok: false, error: `API key rejected (HTTP ${keyResponse.status})` }
    }
    if (!keyResponse.ok) return { ok: false, error: `Key check failed (HTTP ${keyResponse.status})` }

    if (endpointsResponse.status === 404) {
      return { ok: false, error: `Model "${model.id}" is not available on OpenRouter` }
    }
    if (!endpointsResponse.ok) return { ok: false, error: `Endpoint check failed (HTTP ${endpointsResponse.status})` }

    const body = await endpointsResponse.json() as {
      data?: { endpoints?: unknown[]; architecture?: { output_modalities?: unknown } }
    }
    const outputModalities = body.data?.architecture?.output_modalities
    if (Array.isArray(outputModalities) && !outputModalities.includes('image')) {
      return { ok: false, error: `Model "${model.id}" does not generate images` }
    }
    if (!body.data?.endpoints?.length) {
      return { ok: false, error: `Model "${model.id}" has no live endpoints right now` }
    }
    return { ok: true }
  },
}

const IMAGE_BACKENDS: Partial<Record<ImageApi, ImageBackend>> = {
  'openrouter-images': openRouterImageBackend,
}

function requireImageBackend(model: ImageModel<ImageApi>): ImageBackend {
  const backend = IMAGE_BACKENDS[model.api]
  if (!backend) throw new Error(`Image API "${model.api}" is not supported`)
  return backend
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
    const result = await requireImageBackend(model).checkAvailability(
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
  /** Sum of the billed costs the provider reported; `null` when none were reported. */
  costUsd: number | null
  usage: ImageGenerationUsage
  /** One entry per provider request (one per variant), so costs can be booked per image. */
  requests: ImageRequestOutcome[]
  durationMs: number
  errors: string[]
}

async function readJsonSafely(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

const NO_IMAGE_RETURNED = 'The model returned no image. It may have refused the prompt, or answered with a remote image URL, which is not supported.'

export async function generateImagesWithProvider(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
  const model = buildImageModel(request.provider, request.modelId)
  const backend = requireImageBackend(model)
  const apiKey = await getApiKeyForProvider(request.provider)
  const generate = request.generate ?? generateImages
  const fetchImpl = request.fetchImpl ?? fetch
  const count = Math.min(Math.max(1, Math.floor(request.count ?? 1)), IMAGE_GENERATION_MAX_VARIANTS_BOUNDS.max)
  const input: ImagesInputContent[] = [{ type: 'text', text: request.prompt }, ...(request.inputImages ?? [])]
  const startedAt = Date.now()

  const runOne = async () => {
    let reportedCost: number | undefined
    // Only the cost is kept from the raw body; it also carries the base64
    // images and, for Gemini, a ~1 MB reasoning signature.
    const fetchCapturingCost: FetchFunction = async (url, init) => {
      const response = await fetchImpl(url, init)
      reportedCost = backend.extractCost(await readJsonSafely(response.clone()))
      return response
    }
    const result = await generate(model, { input }, {
      apiKey,
      fetch: fetchCapturingCost,
      timeoutMs: request.timeoutMs ?? IMAGE_GENERATION_TIMEOUT_MS,
      maxRetries: 0,
      signal: request.signal,
      onPayload: (payload) => backend.applyParameters(payload as Record<string, unknown>, request.parameters ?? {}),
    })
    return { result, reportedCost }
  }

  const outcomes = await Promise.all(Array.from({ length: count }, runOne))

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

  return { model, images, texts, costUsd, usage, requests, durationMs: Date.now() - startedAt, errors }
}

export interface UsableImageModel {
  provider: ProviderConfig
  modelId: string
}

export function listUsableImageModels(providers: ProviderConfig[] = loadProvidersDecrypted().providers): UsableImageModel[] {
  return providers.flatMap(provider => getUsableImageModels(provider).map(modelId => ({ provider, modelId })))
}

function hasUsableImageModels(): boolean {
  try {
    return listUsableImageModels(loadProviders().providers).length > 0
  } catch {
    return false
  }
}

/** `settings.json → imageGeneration`, with defaults for missing or invalid values. */
export function readImageGenerationSettings(): ImageGenerationSettingsContract {
  try {
    ensureConfigTemplates()
    const settings = loadConfig<{ imageGeneration?: Partial<ImageGenerationSettingsContract> }>('settings.json')
    return normalizeImageGenerationSettings(settings.imageGeneration)
  } catch {
    return normalizeImageGenerationSettings(undefined)
  }
}

/** `generate_image` is offered only while image generation is switched on and an image model is usable. */
export function isImageGenerationAvailable(): boolean {
  return readImageGenerationSettings().enabled && hasUsableImageModels()
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
