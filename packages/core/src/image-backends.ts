import type { FetchFunction, ImageApi, ImageModel } from '@earendil-works/pi-ai'
import { extractCodexAccountId } from './codex-auth.js'
import { compareOpenAIImageModelIds, findOpenAIImageModelInfo, openAIImageModelName } from './image-catalog.js'
import type { AvailableImageModel, ImageModality, ImageModelPricing } from './image-catalog.js'
import { OPENAI_CODEX_IMAGES_API, OPENAI_IMAGES_API } from './openai-images-api.js'
import { OPENROUTER_IMAGES_API } from './openrouter-images-api.js'
import type { OpenAIImagesResponse } from './openai-images-api.js'

/**
 * How a generation is paid for:
 * - `reported`: the provider reports the billed amount (OpenRouter)
 * - `estimated`: computed from reported tokens and list prices (OpenAI API)
 * - `subscription`: included in a plan, consumes its usage limits (ChatGPT/Codex)
 */
export type ImageBilling = 'reported' | 'estimated' | 'subscription'

export const IMAGE_QUALITIES = ['low', 'medium', 'high', 'auto'] as const
export type ImageQuality = (typeof IMAGE_QUALITIES)[number]
export const IMAGE_BACKGROUNDS = ['transparent', 'opaque', 'auto'] as const
export type ImageBackground = (typeof IMAGE_BACKGROUNDS)[number]

export interface ImageGenerationParameters {
  aspectRatio?: string
  quality?: ImageQuality
  background?: ImageBackground
}

export type PreparedImageParameters =
  | { ok: true; payload: Record<string, unknown>; notes: string[] }
  | { ok: false; error: string }

/** The provider rejected the credentials; a fallback model list would hide that. */
export class ImageProviderAuthError extends Error {
  constructor(public readonly status: number) {
    super(`API key rejected (HTTP ${status})`)
    this.name = 'ImageProviderAuthError'
  }
}

function assertAuthorized(response: Response): void {
  if (response.status === 401 || response.status === 403) throw new ImageProviderAuthError(response.status)
}

export type ImageAvailability =
  | { ok: true }
  | { ok: false; error: string }

/**
 * Wire-level behaviour pi-ai does not cover for an image API: optional
 * request parameters, the cost, a free availability probe and the live model
 * list. Keyed by pi-ai `ImageApi`.
 */
export interface ImageBackend {
  billing: ImageBilling
  /** Whether ids outside the catalog can be added; the provider resolves them. */
  customModels: boolean
  /** Variants are separate requests; at most this many run at the same time. */
  maxParallel: number
  maxInputImages: number
  /** Request fields for the optional parameters, or why the request cannot be made. */
  prepare(model: ImageModel<ImageApi>, params: ImageGenerationParameters): PreparedImageParameters
  extractCost(rawResponse: unknown, model: ImageModel<ImageApi>): number | undefined
  checkAvailability(model: ImageModel<ImageApi>, apiKey: string, fetchImpl: FetchFunction, signal: AbortSignal): Promise<ImageAvailability>
  listModels?(baseUrl: string, apiKey: string, fetchImpl: FetchFunction, signal: AbortSignal): Promise<AvailableImageModel[]>
  /** One-line usage-limit summary from the response headers of a generation. */
  describeUsage?(headers: Record<string, string>): string | undefined
}

const PARAMETER_NAMES: Record<keyof ImageGenerationParameters, string> = {
  aspectRatio: 'aspect_ratio',
  quality: 'quality',
  background: 'background',
}

function ignoredParameters(params: ImageGenerationParameters, keys: Array<keyof ImageGenerationParameters>): string[] {
  return keys.filter(key => params[key] !== undefined).map(key => PARAMETER_NAMES[key])
}

function trimBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

function encodeModelPath(modelId: string): string {
  return modelId.split('/').map(encodeURIComponent).join('/')
}

function toModalities(value: unknown): ImageModality[] {
  return Array.isArray(value) ? value.filter((entry): entry is ImageModality => entry === 'text' || entry === 'image') : []
}

// ── OpenRouter ──

interface OpenRouterModelEntry {
  id?: unknown
  name?: unknown
  architecture?: { input_modalities?: unknown; output_modalities?: unknown }
  /** USD per token, as strings. */
  pricing?: { prompt?: unknown; completion?: unknown; image_token?: unknown; image_output?: unknown }
}

function perMillionTokens(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const perMillion = Number(value) * 1_000_000
  return Number.isFinite(perMillion) && perMillion >= 0 ? Math.round(perMillion * 1e6) / 1e6 : undefined
}

function openRouterPricing(pricing: OpenRouterModelEntry['pricing']): ImageModelPricing | undefined {
  const imageOutput = perMillionTokens(pricing?.image_output)
  if (!imageOutput) return undefined
  const textInput = perMillionTokens(pricing?.prompt) ?? 0
  const textOutput = perMillionTokens(pricing?.completion)
  return {
    textInput,
    imageInput: perMillionTokens(pricing?.image_token) ?? textInput,
    imageOutput,
    ...(textOutput && { textOutput }),
  }
}

const openRouterImageBackend: ImageBackend = {
  billing: 'reported',
  customModels: true,
  maxParallel: Number.POSITIVE_INFINITY,
  maxInputImages: Number.POSITIVE_INFINITY,

  prepare(_model, params) {
    const ignored = ignoredParameters(params, ['quality', 'background'])
    return {
      ok: true,
      payload: params.aspectRatio ? { aspect_ratio: params.aspectRatio } : {},
      notes: ignored.length > 0 ? [`${ignored.join(' and ')} is not supported for OpenRouter image models and was ignored.`] : [],
    }
  },

  // Per-token catalog rates are zero or far off for most image models.
  // OpenRouter reports the billed amount here.
  extractCost(rawResponse) {
    const cost = (rawResponse as { usage?: { cost?: unknown } } | null)?.usage?.cost
    return typeof cost === 'number' && Number.isFinite(cost) ? cost : undefined
  },

  async checkAvailability(model, apiKey, fetchImpl, signal) {
    const baseUrl = trimBaseUrl(model.baseUrl)
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

  async listModels(baseUrl, apiKey, fetchImpl, signal) {
    const response = await fetchImpl(`${trimBaseUrl(baseUrl)}/models?output_modalities=image`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
      signal,
    })
    assertAuthorized(response)
    if (!response.ok) throw new Error(`OpenRouter model list failed (HTTP ${response.status})`)
    const body = await response.json() as { data?: OpenRouterModelEntry[] }
    const models: AvailableImageModel[] = []
    for (const entry of body.data ?? []) {
      const id = typeof entry.id === 'string' ? entry.id.trim() : ''
      const output = toModalities(entry.architecture?.output_modalities)
      if (!id || !output.includes('image')) continue
      const input = toModalities(entry.architecture?.input_modalities)
      const pricing = openRouterPricing(entry.pricing)
      models.push({
        id,
        name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : id,
        input: input.includes('text') ? input : ['text', ...input],
        output,
        ...(pricing && { pricing }),
      })
    }
    return models.sort((a, b) => a.name.localeCompare(b.name))
  },
}

// ── OpenAI Images API (API key) ──

const FIXED_SIZES = [
  { size: '1024x1024', ratio: 1 },
  { size: '1536x1024', ratio: 3 / 2 },
  { size: '1024x1536', ratio: 2 / 3 },
]
const FLEXIBLE_TARGET_PIXELS = 1024 * 1024
const FLEXIBLE_MAX_RATIO = 3

function parseAspectRatio(aspectRatio: string): number | undefined {
  const [width, height] = aspectRatio.split(':').map(Number)
  return width && height && width > 0 && height > 0 ? width / height : undefined
}

function roundToMultipleOf16(value: number): number {
  return Math.max(16, Math.round(value / 16) * 16)
}

/** `size` for an aspect ratio: exact for GPT Image 2+, the closest supported size for older models. */
export function openAIImageSize(
  modelId: string,
  aspectRatio: string,
): { ok: true; size: string; note?: string } | { ok: false; error: string } {
  const ratio = parseAspectRatio(aspectRatio)
  if (!ratio) return { ok: false, error: `aspect_ratio "${aspectRatio}" is not a valid ratio.` }

  if (findOpenAIImageModelInfo(modelId)?.sizes === 'flexible') {
    if (ratio > FLEXIBLE_MAX_RATIO || ratio < 1 / FLEXIBLE_MAX_RATIO) {
      return { ok: false, error: `${modelId} supports aspect ratios from 1:3 to 3:1, got ${aspectRatio}.` }
    }
    const width = roundToMultipleOf16(Math.sqrt(FLEXIBLE_TARGET_PIXELS * ratio))
    const height = roundToMultipleOf16(Math.sqrt(FLEXIBLE_TARGET_PIXELS / ratio))
    return { ok: true, size: `${width}x${height}` }
  }

  const closest = FIXED_SIZES.reduce((best, candidate) =>
    Math.abs(Math.log(candidate.ratio / ratio)) < Math.abs(Math.log(best.ratio / ratio)) ? candidate : best)
  const exact = Math.abs(closest.ratio - ratio) < 0.01
  return {
    ok: true,
    size: closest.size,
    ...(!exact && { note: `${modelId} only supports 1024x1024, 1536x1024 or 1024x1536; aspect_ratio ${aspectRatio} was sent as ${closest.size}.` }),
  }
}

const OPENAI_IMAGE_MODEL_ID = /^(gpt-image-|chatgpt-image-)/

const openAIImageBackend: ImageBackend = {
  billing: 'estimated',
  customModels: true,
  maxParallel: Number.POSITIVE_INFINITY,
  maxInputImages: 16,

  prepare(model, params) {
    const payload: Record<string, unknown> = {}
    const notes: string[] = []
    if (params.aspectRatio) {
      const size = openAIImageSize(model.id, params.aspectRatio)
      if (!size.ok) return size
      payload.size = size.size
      if (size.note) notes.push(size.note)
    }
    if (params.quality) payload.quality = params.quality
    if (params.background) {
      if (params.background === 'transparent' && findOpenAIImageModelInfo(model.id)?.transparentBackground === false) {
        return { ok: false, error: `${model.id} cannot render transparent backgrounds. Use a GPT Image 2.5 or 1.x model for transparency.` }
      }
      payload.background = params.background
    }
    return { ok: true, payload, notes }
  },

  extractCost(rawResponse, model) {
    const pricing = findOpenAIImageModelInfo(model.id)?.pricing
    const usage = (rawResponse as OpenAIImagesResponse | null)?.usage
    if (!pricing || !usage) return undefined
    const imageInput = usage.input_tokens_details?.image_tokens ?? 0
    const textInput = usage.input_tokens_details?.text_tokens ?? Math.max(0, (usage.input_tokens ?? 0) - imageInput)
    const textOutput = usage.output_tokens_details?.text_tokens ?? 0
    const imageOutput = usage.output_tokens_details?.image_tokens ?? Math.max(0, (usage.output_tokens ?? 0) - textOutput)
    return (
      textInput * pricing.textInput
      + imageInput * pricing.imageInput
      + imageOutput * pricing.imageOutput
      + textOutput * (pricing.textOutput ?? 0)
    ) / 1_000_000
  },

  async checkAvailability(model, apiKey, fetchImpl, signal) {
    const response = await fetchImpl(`${trimBaseUrl(model.baseUrl)}/models/${encodeURIComponent(model.id)}`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
      signal,
    })
    if (response.status === 401 || response.status === 403) return { ok: false, error: `API key rejected (HTTP ${response.status})` }
    if (response.status === 404) return { ok: false, error: `Model "${model.id}" is not available for this API key` }
    if (!response.ok) return { ok: false, error: `Model check failed (HTTP ${response.status})` }
    return { ok: true }
  },

  async listModels(baseUrl, apiKey, fetchImpl, signal) {
    const response = await fetchImpl(`${trimBaseUrl(baseUrl)}/models`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
      signal,
    })
    assertAuthorized(response)
    if (!response.ok) throw new Error(`OpenAI model list failed (HTTP ${response.status})`)
    const body = await response.json() as { data?: Array<{ id?: unknown }> }
    const ids = [...new Set((body.data ?? [])
      .map(entry => (typeof entry.id === 'string' ? entry.id.trim() : ''))
      .filter(id => OPENAI_IMAGE_MODEL_ID.test(id)))]
    return ids.sort(compareOpenAIImageModelIds).map((id) => {
      const info = findOpenAIImageModelInfo(id)
      return {
        id,
        name: openAIImageModelName(id),
        input: ['text', 'image'] as ImageModality[],
        output: ['image'] as ImageModality[],
        ...(info && { pricing: { ...info.pricing } }),
      }
    })
  },
}

// ── ChatGPT subscription (Codex login) ──

interface CodexUsageBody {
  plan_type?: unknown
  rate_limit?: { allowed?: unknown; limit_reached?: unknown } | null
}

function codexUsageUrl(imagesBaseUrl: string): string {
  return `${trimBaseUrl(imagesBaseUrl).replace(/\/codex$/, '')}/wham/usage`
}

function formatMinutes(totalMinutes: number): string {
  if (totalMinutes >= 60 && totalMinutes % 60 === 0) return `${totalMinutes / 60} h`
  return `${totalMinutes} min`
}

function formatSeconds(totalSeconds: number): string {
  const totalMinutes = Math.ceil(totalSeconds / 60)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours === 0) return `${minutes} min`
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`
}

const codexImageBackend: ImageBackend = {
  billing: 'subscription',
  customModels: false,
  // One at a time: the ChatGPT backend rate-limits image (and input-image) requests per minute.
  maxParallel: 1,
  maxInputImages: 5,

  // The backend picks size and quality itself and ignores both fields (verified
  // October 2026), so the request mirrors the Codex CLI.
  prepare(_model, params) {
    const ignored = ignoredParameters(params, ['aspectRatio', 'quality'])
    return {
      ok: true,
      payload: { size: 'auto', quality: 'auto', background: params.background ?? 'auto' },
      notes: ignored.length > 0
        ? [`The ChatGPT subscription picks image size and quality itself; ${ignored.join(' and ')} was ignored. Describe the format in the prompt instead.`]
        : [],
    }
  },

  extractCost() {
    return 0
  },

  async checkAvailability(model, accessToken, fetchImpl, signal) {
    const accountId = extractCodexAccountId(accessToken)
    if (!accountId) return { ok: false, error: 'The ChatGPT login token carries no account id. Sign in again.' }
    const response = await fetchImpl(codexUsageUrl(model.baseUrl), {
      headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}`, 'ChatGPT-Account-Id': accountId },
      signal,
    })
    if (response.status === 401 || response.status === 403) {
      return { ok: false, error: `ChatGPT login rejected (HTTP ${response.status}). Sign in again.` }
    }
    if (!response.ok) return { ok: false, error: `Usage check failed (HTTP ${response.status})` }
    const body = await response.json() as CodexUsageBody
    if (body.plan_type === 'free') {
      return { ok: false, error: 'Image generation is not included in the ChatGPT Free plan.' }
    }
    if (body.rate_limit?.limit_reached === true || body.rate_limit?.allowed === false) {
      return { ok: false, error: 'The Codex usage limit of this ChatGPT plan is reached.' }
    }
    return { ok: true }
  },

  describeUsage(headers) {
    if (!headers['x-codex-active-limit']?.includes('imagegen')) return undefined
    const used = Number(headers['x-codex-primary-used-percent'])
    if (!Number.isFinite(used)) return undefined
    const windowMinutes = Number(headers['x-codex-primary-window-minutes'])
    const resetSeconds = Number(headers['x-codex-primary-reset-after-seconds'])
    const window = Number.isFinite(windowMinutes) && windowMinutes > 0 ? ` of the ${formatMinutes(windowMinutes)} window` : ''
    const reset = Number.isFinite(resetSeconds) && resetSeconds > 0 ? `, resets in ${formatSeconds(resetSeconds)}` : ''
    return `ChatGPT image limit: ${used}% used${window}${reset}.`
  },
}

const IMAGE_BACKENDS: Partial<Record<ImageApi, ImageBackend>> = {
  [OPENROUTER_IMAGES_API]: openRouterImageBackend,
  [OPENAI_IMAGES_API]: openAIImageBackend,
  [OPENAI_CODEX_IMAGES_API]: codexImageBackend,
}

export function getImageBackend(api: ImageApi): ImageBackend | undefined {
  return IMAGE_BACKENDS[api]
}

export function requireImageBackend(api: ImageApi): ImageBackend {
  const backend = IMAGE_BACKENDS[api]
  if (!backend) throw new Error(`Image API "${api}" is not supported`)
  return backend
}
