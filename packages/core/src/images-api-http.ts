import type {
  AssistantImages,
  ImageApi,
  ImageContent,
  ImageModel,
  ImagesContext,
  ImagesOptions,
  ProviderHeaders,
  Usage,
} from '@earendil-works/pi-ai'

export interface ImagesRequestSpec {
  /** Path below the model's base URL, chosen from the final payload. */
  path(payload: Record<string, unknown>): string
  authHeaders(apiKey: string): Record<string, string>
  describeError(status: number, body: unknown, fallbackText: string): string
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

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** Unlike error bodies (often plain text or HTML), a 2xx body must be a JSON object. */
function parseSuccessBody(status: number, text: string): Record<string, unknown> {
  const body = tryParseJson(text)
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error(`HTTP ${status}: The provider answered without a JSON object: ${text.trim().slice(0, 200) || '(empty body)'}`)
  }
  return body as Record<string, unknown>
}

export function splitImagesInput(context: ImagesContext): { prompt: string; images: ImageContent[] } {
  return {
    prompt: context.input
      .filter(part => part.type === 'text')
      .map(part => part.text)
      .join('\n\n'),
    images: context.input.filter((part): part is ImageContent => part.type === 'image'),
  }
}

export function imageDataUrl(image: ImageContent): string {
  return `data:${image.mimeType};base64,${image.data}`
}

export function tokenUsage(model: ImageModel<ImageApi>, input: number, output: number, total = input + output): Usage {
  const inputCost = (model.cost.input / 1_000_000) * input
  const outputCost = (model.cost.output / 1_000_000) * output
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: total,
    cost: { input: inputCost, output: outputCost, cacheRead: 0, cacheWrite: 0, total: inputCost + outputCost },
  }
}

/** POSTs the payload (after `onPayload`) and returns the parsed body; non-2xx responses throw. */
export async function postImagesRequest(
  model: ImageModel<ImageApi>,
  initialPayload: Record<string, unknown>,
  options: ImagesOptions | undefined,
  spec: ImagesRequestSpec,
): Promise<{ payload: Record<string, unknown>; body: unknown }> {
  const apiKey = options?.apiKey
  if (!apiKey) throw new Error(`No API key for provider: ${model.provider}`)

  const payload = ((await options?.onPayload?.(initialPayload, model)) ?? initialPayload) as Record<string, unknown>
  const headers = mergeHeaders({
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...model.headers,
    ...spec.authHeaders(apiKey),
  }, options?.headers)

  const response = await (options?.fetch ?? globalThis.fetch)(`${model.baseUrl.replace(/\/+$/, '')}/${spec.path(payload)}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: requestSignal(options),
  })
  await options?.onResponse?.({ status: response.status, headers: Object.fromEntries(response.headers) }, model)

  const text = await response.text()
  if (!response.ok) throw new Error(spec.describeError(response.status, tryParseJson(text), text))
  return { payload, body: parseSuccessBody(response.status, text) }
}

/** Runs `fill` on a fresh result and turns any thrown error into an error result, as pi-ai image APIs do. */
export async function generateImagesSafely(
  model: ImageModel<ImageApi>,
  options: ImagesOptions | undefined,
  fill: (output: AssistantImages) => Promise<void>,
): Promise<AssistantImages> {
  const output: AssistantImages = {
    api: model.api,
    provider: model.provider,
    model: model.id,
    output: [],
    stopReason: 'stop',
    timestamp: Date.now(),
  }
  try {
    await fill(output)
  } catch (error) {
    output.stopReason = options?.signal?.aborted ? 'aborted' : 'error'
    output.errorMessage = (error as Error).name === 'TimeoutError'
      ? `Image generation timed out after ${Math.round((options?.timeoutMs ?? 0) / 1000)} s`
      : (error as Error).message
  }
  return output
}
