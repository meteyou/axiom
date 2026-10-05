import type {
  AssistantImages,
  ImageApi,
  ImageContent,
  ImageModel,
  ImagesContext,
  ImagesOptions,
  ProviderHeaders,
  ProviderImages,
  Usage,
} from '@earendil-works/pi-ai'
import { extractCodexAccountId } from './codex-auth.js'

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
  const prompt = context.input
    .filter(part => part.type === 'text')
    .map(part => part.text)
    .join('\n\n')
  const images = context.input.filter((part): part is ImageContent => part.type === 'image')
  return {
    model: model.id,
    prompt,
    ...(images.length > 0 && {
      images: images.map(image => ({ image_url: `data:${image.mimeType};base64,${image.data}` })),
    }),
  }
}

function mergeHeaders(base: Record<string, string>, extra: ProviderHeaders | undefined): Record<string, string> {
  const headers = { ...base }
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (value === null) delete headers[key]
    else headers[key] = value
  }
  return headers
}

function requestSignal(options: ImagesOptions | undefined): AbortSignal | undefined {
  const signals = [
    options?.signal,
    options?.timeoutMs !== undefined ? AbortSignal.timeout(options.timeoutMs) : undefined,
  ].filter((signal): signal is AbortSignal => signal !== undefined)
  if (signals.length === 0) return undefined
  return signals.length === 1 ? signals[0] : AbortSignal.any(signals)
}

function toUsage(raw: OpenAIImagesUsage | undefined, model: ImageModel<ImageApi>): Usage | undefined {
  if (!raw) return undefined
  const input = raw.input_tokens ?? 0
  const output = raw.output_tokens ?? 0
  const inputCost = (model.cost.input / 1_000_000) * input
  const outputCost = (model.cost.output / 1_000_000) * output
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: raw.total_tokens ?? input + output,
    cost: { input: inputCost, output: outputCost, cacheRead: 0, cacheWrite: 0, total: inputCost + outputCost },
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

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

async function postImagesRequest(
  model: ImageModel<ImageApi>,
  context: ImagesContext,
  options: ImagesOptions | undefined,
  authHeaders: AuthHeaders,
): Promise<{ payload: Record<string, unknown>; result: OpenAIImagesResponse }> {
  const apiKey = options?.apiKey
  if (!apiKey) throw new Error(`No API key for provider: ${model.provider}`)

  const initialPayload = buildPayload(model, context)
  const payload = ((await options?.onPayload?.(initialPayload, model)) ?? initialPayload) as Record<string, unknown>
  const endpoint = Array.isArray(payload.images) && payload.images.length > 0 ? 'edits' : 'generations'
  const headers = mergeHeaders({
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...model.headers,
    ...authHeaders(apiKey),
  }, options?.headers)

  const response = await (options?.fetch ?? globalThis.fetch)(`${model.baseUrl.replace(/\/+$/, '')}/images/${endpoint}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: requestSignal(options),
  })
  await options?.onResponse?.({ status: response.status, headers: Object.fromEntries(response.headers) }, model)

  const text = await response.text()
  const body = parseJson(text)
  if (!response.ok) throw new Error(describeImagesApiError(response.status, body, text))
  return { payload, result: (body ?? {}) as OpenAIImagesResponse }
}

function describeFailure(error: unknown, options: ImagesOptions | undefined): string {
  return (error as Error).name === 'TimeoutError'
    ? `Image generation timed out after ${Math.round((options?.timeoutMs ?? 0) / 1000)} s`
    : (error as Error).message
}

function createImagesApi(authHeaders: AuthHeaders): ProviderImages {
  return {
    async generateImages(model, context, options): Promise<AssistantImages> {
      const output: AssistantImages = {
        api: model.api,
        provider: model.provider,
        model: model.id,
        output: [],
        stopReason: 'stop',
        timestamp: Date.now(),
      }

      try {
        const { payload, result } = await postImagesRequest(model, context, options, authHeaders)
        const format = String(result.output_format ?? payload.output_format ?? 'png').toLowerCase()
        const mimeType = MIME_TYPE_BY_FORMAT[format] ?? `image/${format}`
        output.responseId = result.data?.find(entry => entry.generation_id)?.generation_id
        output.usage = toUsage(result.usage, model)
        for (const entry of result.data ?? []) {
          if (entry.b64_json) output.output.push({ type: 'image', mimeType, data: entry.b64_json })
        }
      } catch (error) {
        output.stopReason = options?.signal?.aborted ? 'aborted' : 'error'
        output.errorMessage = describeFailure(error, options)
      }
      return output
    },
  }
}

export function openAIImagesApi(): ProviderImages {
  return createImagesApi(apiKeyHeaders)
}

export function openAICodexImagesApi(): ProviderImages {
  return createImagesApi(codexHeaders)
}
