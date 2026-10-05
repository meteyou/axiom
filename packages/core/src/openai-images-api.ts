import type { ImageApi, ImageModel, ImagesContext, ProviderImages } from '@earendil-works/pi-ai'
import { extractCodexAccountId } from './codex-auth.js'
import { generateImagesSafely, imageDataUrl, postImagesRequest, splitImagesInput, tokenUsage } from './images-api-http.js'
import type { ImagesRequestSpec } from './images-api-http.js'

/** OpenAI Images API (`/v1/images/generations` and `/v1/images/edits`), API-key billed. */
export const OPENAI_IMAGES_API = 'openai-images'
/** Same wire format on the ChatGPT backend, used by Codex with a ChatGPT login. */
export const OPENAI_CODEX_IMAGES_API = 'openai-codex-images'

export const OPENAI_IMAGES_BASE_URL = 'https://api.openai.com/v1'
export const OPENAI_CODEX_IMAGES_BASE_URL = 'https://chatgpt.com/backend-api/codex'

export interface OpenAIImagesUsage {
  input_tokens?: number
  input_tokens_details?: { text_tokens?: number; image_tokens?: number }
  output_tokens?: number
  output_tokens_details?: { text_tokens?: number; image_tokens?: number }
  total_tokens?: number
}

export interface OpenAIImagesResponse {
  created?: number
  data?: Array<{ b64_json?: string; url?: string; generation_id?: string }>
  output_format?: string
  size?: string
  quality?: string
  background?: string
  usage?: OpenAIImagesUsage
}

interface OpenAIImagesErrorBody {
  error?: {
    message?: unknown
    type?: unknown
    code?: unknown
    resets_at?: unknown
  } | string
  detail?: unknown
}

const MIME_TYPE_BY_FORMAT: Record<string, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  webp: 'image/webp',
}

type AuthHeaders = (apiKey: string) => Record<string, string>

const apiKeyHeaders: AuthHeaders = apiKey => ({ Authorization: `Bearer ${apiKey}` })

const codexHeaders: AuthHeaders = (accessToken) => {
  const accountId = extractCodexAccountId(accessToken)
  if (!accountId) throw new Error('The ChatGPT login token carries no account id. Sign in again.')
  return {
    Authorization: `Bearer ${accessToken}`,
    'ChatGPT-Account-ID': accountId,
    // Same originator pi-ai sends for Codex chat requests.
    originator: 'pi',
  }
}

function buildPayload(model: ImageModel<ImageApi>, context: ImagesContext): Record<string, unknown> {
  const { prompt, images } = splitImagesInput(context)
  return {
    model: model.id,
    prompt,
    ...(images.length > 0 && { images: images.map(image => ({ image_url: imageDataUrl(image) })) }),
  }
}

function formatResetTime(resetsAt: unknown): string {
  if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt)) return ''
  return ` It resets at ${new Date(resetsAt * 1000).toISOString()}.`
}

/** Readable message for an error body of the OpenAI Images API or the ChatGPT backend. */
export function describeImagesApiError(status: number, body: unknown, fallbackText: string): string {
  const parsed = (body ?? {}) as OpenAIImagesErrorBody
  const error = typeof parsed.error === 'object' && parsed.error !== null ? parsed.error : undefined
  const type = typeof error?.type === 'string' ? error.type : undefined
  const code = typeof error?.code === 'string' ? error.code : undefined

  if (type === 'usage_limit_reached') {
    return `HTTP ${status}: The ChatGPT usage limit for image generation is reached.${formatResetTime(error?.resets_at)}`
  }
  if (type === 'usage_not_included') {
    return `HTTP ${status}: Image generation is not included in this ChatGPT plan.`
  }

  const message = [
    typeof error?.message === 'string' ? error.message : undefined,
    typeof parsed.error === 'string' ? parsed.error : undefined,
    typeof parsed.detail === 'string' ? parsed.detail : undefined,
  ].find(value => value && value.trim()) ?? (fallbackText.trim().slice(0, 300) || 'Request failed')
  const suffix = code && !message.includes(code) ? ` (${code})` : ''
  return `HTTP ${status}: ${message}${suffix}`
}

function createImagesApi(authHeaders: AuthHeaders): ProviderImages {
  const spec: ImagesRequestSpec = {
    path: payload => (Array.isArray(payload.images) && payload.images.length > 0 ? 'images/edits' : 'images/generations'),
    authHeaders,
    describeError: describeImagesApiError,
  }
  return {
    generateImages: (model, context, options) => generateImagesSafely(model, options, async (output) => {
      const { payload, body } = await postImagesRequest(model, buildPayload(model, context), options, spec)
      const result = body as OpenAIImagesResponse
      const format = String(result.output_format ?? payload.output_format ?? 'png').toLowerCase()
      const mimeType = MIME_TYPE_BY_FORMAT[format] ?? `image/${format}`
      output.responseId = result.data?.find(entry => entry.generation_id)?.generation_id
      if (result.usage) {
        output.usage = tokenUsage(model, result.usage.input_tokens ?? 0, result.usage.output_tokens ?? 0, result.usage.total_tokens)
      }
      for (const entry of result.data ?? []) {
        if (entry.b64_json) output.output.push({ type: 'image', mimeType, data: entry.b64_json })
      }
    }),
  }
}

export function openAIImagesApi(): ProviderImages {
  return createImagesApi(apiKeyHeaders)
}

export function openAICodexImagesApi(): ProviderImages {
  return createImagesApi(codexHeaders)
}
