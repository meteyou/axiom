import { describe, expect, it, vi } from 'vitest'
import type { FetchFunction, ImageApi, ImageModel } from '@earendil-works/pi-ai'
import { describeImagesApiError, openAICodexImagesApi, openAIImagesApi } from './openai-images-api.js'

const PNG_BASE64 = Buffer.from('png-bytes').toString('base64')

function fakeCodexToken(accountId: string | null): string {
  const payload = accountId ? { 'https://api.openai.com/auth': { chatgpt_account_id: accountId } } : {}
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`
}

const openAIModel: ImageModel<ImageApi> = {
  type: 'image',
  id: 'gpt-image-2',
  name: 'GPT Image 2',
  api: 'openai-images',
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1/',
  input: ['text', 'image'],
  output: ['image'],
  cost: { input: 5, output: 30, cacheRead: 0, cacheWrite: 0 },
}

const codexModel: ImageModel<ImageApi> = {
  ...openAIModel,
  api: 'openai-codex-images',
  provider: 'openai-codex',
  baseUrl: 'https://chatgpt.com/backend-api/codex',
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}

interface RecordedRequest {
  url: string
  headers: Headers
  body: Record<string, unknown>
}

function stubFetch(respond: () => Response): { fetchImpl: FetchFunction; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = []
  const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
    requests.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, unknown> })
    return respond()
  }) as unknown as FetchFunction
  return { fetchImpl, requests }
}

function imagesResponse(overrides: Record<string, unknown> = {}, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({
    created: 1,
    data: [{ b64_json: PNG_BASE64, generation_id: 'gen-1' }],
    output_format: 'png',
    usage: { input_tokens: 20, input_tokens_details: { text_tokens: 20, image_tokens: 0 }, output_tokens: 1000, total_tokens: 1020 },
    ...overrides,
  }), { status: 200, headers: { 'content-type': 'application/json', ...headers } })
}

describe('OpenAI Images API (API key)', () => {
  it('posts a generation with the API key and returns the image, usage and generation id', async () => {
    const { fetchImpl, requests } = stubFetch(() => imagesResponse())
    const result = await openAIImagesApi().generateImages(openAIModel, { input: [{ type: 'text', text: 'a fox' }] }, {
      apiKey: 'sk-test',
      fetch: fetchImpl,
      onPayload: payload => ({ ...(payload as Record<string, unknown>), size: '1360x768' }),
    })

    expect(result.stopReason).toBe('stop')
    expect(result.output).toEqual([{ type: 'image', mimeType: 'image/png', data: PNG_BASE64 }])
    expect(result.responseId).toBe('gen-1')
    expect(result.usage).toMatchObject({ input: 20, output: 1000, totalTokens: 1020 })
    expect(requests[0]!.url).toBe('https://api.openai.com/v1/images/generations')
    expect(requests[0]!.headers.get('authorization')).toBe('Bearer sk-test')
    expect(requests[0]!.headers.get('chatgpt-account-id')).toBeNull()
    expect(requests[0]!.body).toEqual({ model: 'gpt-image-2', prompt: 'a fox', size: '1360x768' })
  })

  it('sends input images as data URLs to the edits endpoint', async () => {
    const { fetchImpl, requests } = stubFetch(() => imagesResponse({ output_format: 'webp' }))
    const result = await openAIImagesApi().generateImages(openAIModel, {
      input: [{ type: 'text', text: 'make it blue' }, { type: 'image', mimeType: 'image/png', data: PNG_BASE64 }],
    }, { apiKey: 'sk-test', fetch: fetchImpl })

    expect(requests[0]!.url).toBe('https://api.openai.com/v1/images/edits')
    expect(requests[0]!.body.images).toEqual([{ image_url: `data:image/png;base64,${PNG_BASE64}` }])
    expect(result.output[0]).toMatchObject({ mimeType: 'image/webp' })
  })

  it('reports HTTP errors with the provider message instead of throwing', async () => {
    const { fetchImpl } = stubFetch(() => new Response(JSON.stringify({
      error: { message: 'You have no credits remaining.', type: 'insufficient_quota', code: 'credit_balance_exhausted' },
    }), { status: 429 }))
    const result = await openAIImagesApi().generateImages(openAIModel, { input: [{ type: 'text', text: 'x' }] }, { apiKey: 'sk', fetch: fetchImpl })

    expect(result.stopReason).toBe('error')
    expect(result.errorMessage).toBe('HTTP 429: You have no credits remaining. (credit_balance_exhausted)')
    expect(result.output).toEqual([])
  })

  it('fails without an API key and reports aborts', async () => {
    const { fetchImpl } = stubFetch(() => imagesResponse())
    const missingKey = await openAIImagesApi().generateImages(openAIModel, { input: [{ type: 'text', text: 'x' }] }, { fetch: fetchImpl })
    expect(missingKey).toMatchObject({ stopReason: 'error', errorMessage: 'No API key for provider: openai' })

    const controller = new AbortController()
    controller.abort()
    const aborting = vi.fn(async (_url: unknown, init?: RequestInit) => {
      init?.signal?.throwIfAborted()
      return imagesResponse()
    }) as unknown as FetchFunction
    const aborted = await openAIImagesApi().generateImages(openAIModel, { input: [{ type: 'text', text: 'x' }] }, {
      apiKey: 'sk',
      fetch: aborting,
      signal: controller.signal,
    })
    expect(aborted.stopReason).toBe('aborted')
  })
})

describe('ChatGPT backend (Codex login)', () => {
  it('adds the account id from the login token and passes response headers on', async () => {
    const { fetchImpl, requests } = stubFetch(() => imagesResponse({}, { 'x-codex-active-limit': 'imagegen_premium' }))
    const onResponse = vi.fn()
    const result = await openAICodexImagesApi().generateImages(codexModel, { input: [{ type: 'text', text: 'a fox' }] }, {
      apiKey: fakeCodexToken('acc-1'),
      fetch: fetchImpl,
      onResponse,
    })

    expect(result.stopReason).toBe('stop')
    expect(requests[0]!.url).toBe('https://chatgpt.com/backend-api/codex/images/generations')
    expect(requests[0]!.headers.get('chatgpt-account-id')).toBe('acc-1')
    expect(requests[0]!.headers.get('originator')).toBe('pi')
    expect(onResponse).toHaveBeenCalledWith(
      { status: 200, headers: expect.objectContaining({ 'x-codex-active-limit': 'imagegen_premium' }) },
      codexModel,
    )
  })

  it('rejects tokens without an account id before sending anything', async () => {
    const { fetchImpl, requests } = stubFetch(() => imagesResponse())
    const result = await openAICodexImagesApi().generateImages(codexModel, { input: [{ type: 'text', text: 'x' }] }, {
      apiKey: fakeCodexToken(null),
      fetch: fetchImpl,
    })
    expect(result).toMatchObject({ stopReason: 'error', errorMessage: expect.stringMatching(/no account id/) })
    expect(requests).toHaveLength(0)
  })
})

describe('describeImagesApiError', () => {
  it('explains ChatGPT plan limits', () => {
    expect(describeImagesApiError(429, { error: { type: 'usage_limit_reached', resets_at: 1_791_311_991 } }, ''))
      .toBe('HTTP 429: The ChatGPT usage limit for image generation is reached. It resets at 2026-10-06T18:39:51.000Z.')
    expect(describeImagesApiError(403, { error: { type: 'usage_not_included' } }, ''))
      .toBe('HTTP 403: Image generation is not included in this ChatGPT plan.')
  })

  it('falls back to detail strings and the raw body', () => {
    expect(describeImagesApiError(400, { detail: 'Bad request' }, '')).toBe('HTTP 400: Bad request')
    expect(describeImagesApiError(502, null, '<html>Bad gateway</html>')).toBe('HTTP 502: <html>Bad gateway</html>')
    expect(describeImagesApiError(500, null, '')).toBe('HTTP 500: Request failed')
  })
})
