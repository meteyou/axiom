import type { ImageApi, ImageContent, ImageModel, ImagesContext, ProviderImages } from '@earendil-works/pi-ai'
import { generateImagesSafely, imageDataUrl, postImagesRequest, splitImagesInput, tokenUsage } from './images-api-http.js'
import type { ImagesRequestSpec } from './images-api-http.js'

/**
 * OpenRouter's dedicated Image API (`POST /images`). pi-ai's own
 * `openrouter-images` goes through `/chat/completions`, which OpenRouter
 * rejects with a 404 for image-only models such as `qwen/qwen-image-3-pro`.
 */
export const OPENROUTER_IMAGES_API = 'openrouter-images'

interface OpenRouterImagesResponse {
  id?: unknown
  data?: Array<{ b64_json?: unknown; media_type?: unknown }>
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cost?: number }
}

interface OpenRouterErrorBody {
  error?: { message?: unknown } | string
  message?: unknown
}

function buildPayload(model: ImageModel<ImageApi>, context: ImagesContext): Record<string, unknown> {
  const { prompt, images } = splitImagesInput(context)
  return {
    model: model.id,
    prompt,
    ...(images.length > 0 && {
      input_references: images.map(image => ({ type: 'image_url', image_url: { url: imageDataUrl(image) } })),
    }),
  }
}

function describeOpenRouterImagesError(status: number, body: unknown, fallbackText: string): string {
  const parsed = (body ?? {}) as OpenRouterErrorBody
  const message = [
    typeof parsed.error === 'object' && parsed.error !== null ? parsed.error.message : parsed.error,
    parsed.message,
  ].find((value): value is string => typeof value === 'string' && value.trim() !== '')
  return `HTTP ${status}: ${message ?? (fallbackText.trim().slice(0, 300) || 'Request failed')}`
}

function toImages(data: OpenRouterImagesResponse['data']): ImageContent[] {
  return (data ?? []).flatMap((entry) => {
    if (typeof entry.b64_json !== 'string' || !entry.b64_json) return []
    const mimeType = typeof entry.media_type === 'string' && entry.media_type ? entry.media_type : 'image/png'
    return [{ type: 'image' as const, mimeType, data: entry.b64_json }]
  })
}

const spec: ImagesRequestSpec = {
  path: () => 'images',
  authHeaders: apiKey => ({ Authorization: `Bearer ${apiKey}` }),
  describeError: describeOpenRouterImagesError,
}

export function openRouterImagesApi(): ProviderImages {
  return {
    generateImages: (model, context, options) => generateImagesSafely(model, options, async (output) => {
      const { body } = await postImagesRequest(model, buildPayload(model, context), options, spec)
      const result = body as OpenRouterImagesResponse
      if (typeof result.id === 'string') output.responseId = result.id
      if (result.usage) {
        output.usage = tokenUsage(model, result.usage.prompt_tokens ?? 0, result.usage.completion_tokens ?? 0, result.usage.total_tokens)
      }
      output.output.push(...toImages(result.data))
    }),
  }
}
