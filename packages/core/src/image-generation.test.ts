import { describe, expect, it, vi } from 'vitest'
import type { FetchFunction } from '@earendil-works/pi-ai'
import {
  checkImageModelAvailability,
  generateImagesWithProvider,
  MAX_IMAGES_PER_CALL,
  resolveImageModel,
} from './image-generation.js'
import type { UsableImageModel } from './image-generation.js'
import type { ProviderConfig } from './provider-config.js'

const PNG_BASE64 = Buffer.from('fake-png-bytes').toString('base64')

function openRouterProvider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'or-1',
    name: 'OpenRouter',
    type: 'openai-completions',
    providerType: 'openrouter',
    provider: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: 'test-key',
    authMethod: 'api-key',
    enabledImageModels: ['recraft/recraft-v4.1', 'google/gemini-3.1-flash-image'],
    ...overrides,
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function openRouterImageResponse(options: { imageUrl?: string; cost?: number; content?: string | null } = {}): unknown {
  return {
    id: 'gen-123',
    object: 'chat.completion',
    created: 1,
    model: 'recraft/recraft-v4.1',
    choices: [{
      index: 0,
      finish_reason: 'stop',
      message: {
        role: 'assistant',
        content: options.content ?? null,
        reasoning_details: [{ type: 'reasoning.text', signature: 'x'.repeat(1000) }],
        images: [{ type: 'image_url', image_url: { url: options.imageUrl ?? `data:image/png;base64,${PNG_BASE64}` } }],
      },
    }],
    usage: { prompt_tokens: 40, completion_tokens: 4000, total_tokens: 4040, cost: options.cost ?? 0.035 },
  }
}

function recordingFetch(respond: () => Response): { fetchImpl: FetchFunction; bodies: Array<Record<string, unknown>> } {
  const bodies: Array<Record<string, unknown>> = []
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
    return respond()
  }) as unknown as FetchFunction
  return { fetchImpl, bodies }
}

describe('generateImagesWithProvider (pi-ai openrouter-images with a stubbed HTTP layer)', () => {
  it('returns the image, the billed cost from the raw response and sends image_config', async () => {
    const { fetchImpl, bodies } = recordingFetch(() => jsonResponse(openRouterImageResponse({ cost: 0.035 })))

    const result = await generateImagesWithProvider({
      provider: openRouterProvider(),
      modelId: 'recraft/recraft-v4.1',
      prompt: 'a sailboat',
      parameters: { aspectRatio: '16:9' },
      fetchImpl,
    })

    expect(result.errors).toEqual([])
    expect(result.images).toEqual([{ mimeType: 'image/png', data: PNG_BASE64, generationId: 'gen-123', costUsd: 0.035 }])
    expect(result.costUsd).toBe(0.035)
    expect(result.usage.output).toBe(4000)
    expect(bodies[0]).toMatchObject({
      model: 'recraft/recraft-v4.1',
      stream: false,
      modalities: ['image'],
      image_config: { aspect_ratio: '16:9' },
    })
  })

  it('omits image_config without an aspect ratio', async () => {
    const { fetchImpl, bodies } = recordingFetch(() => jsonResponse(openRouterImageResponse()))
    await generateImagesWithProvider({ provider: openRouterProvider(), modelId: 'recraft/recraft-v4.1', prompt: 'p', fetchImpl })
    expect(bodies[0]).not.toHaveProperty('image_config')
  })

  it('sends input images as data URLs after the prompt', async () => {
    const { fetchImpl, bodies } = recordingFetch(() => jsonResponse(openRouterImageResponse()))
    await generateImagesWithProvider({
      provider: openRouterProvider(),
      modelId: 'google/gemini-3.1-flash-image',
      prompt: 'make it blue',
      inputImages: [{ type: 'image', mimeType: 'image/png', data: PNG_BASE64 }],
      fetchImpl,
    })
    const messages = bodies[0]!.messages as Array<{ content: Array<Record<string, unknown>> }>
    expect(messages[0]!.content).toEqual([
      { type: 'text', text: 'make it blue' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_BASE64}` } },
    ])
  })

  it('runs one request per image in parallel and caps the count', async () => {
    const { fetchImpl, bodies } = recordingFetch(() => jsonResponse(openRouterImageResponse({ cost: 0.01 })))
    const result = await generateImagesWithProvider({
      provider: openRouterProvider(),
      modelId: 'recraft/recraft-v4.1',
      prompt: 'p',
      count: 9,
      fetchImpl,
    })
    expect(bodies).toHaveLength(MAX_IMAGES_PER_CALL)
    expect(result.images).toHaveLength(MAX_IMAGES_PER_CALL)
    expect(result.costUsd).toBeCloseTo(0.04)
  })

  it('surfaces pi-ai error results instead of throwing', async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse({ error: { message: 'Insufficient credits', code: 402 } }, 402))
    const result = await generateImagesWithProvider({ provider: openRouterProvider(), modelId: 'recraft/recraft-v4.1', prompt: 'p', fetchImpl })
    expect(result.images).toEqual([])
    expect(result.costUsd).toBeNull()
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toMatch(/Insufficient credits|402/)
  })

  it('reports "no image" when the model answers with a remote URL or only text', async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse(openRouterImageResponse({
      imageUrl: 'https://cdn.example.com/image.png',
      content: 'I cannot draw that.',
    })))
    const result = await generateImagesWithProvider({ provider: openRouterProvider(), modelId: 'recraft/recraft-v4.1', prompt: 'p', fetchImpl })
    expect(result.images).toEqual([])
    expect(result.texts).toEqual(['I cannot draw that.'])
    expect(result.errors[0]).toMatch(/returned no image/)
    expect(result.costUsd).toBe(0.035)
  })

  it('keeps the cost null when the provider does not report one', async () => {
    const response = openRouterImageResponse() as { usage: Record<string, unknown> }
    delete response.usage.cost
    const { fetchImpl } = recordingFetch(() => jsonResponse(response))
    const result = await generateImagesWithProvider({ provider: openRouterProvider(), modelId: 'recraft/recraft-v4.1', prompt: 'p', fetchImpl })
    expect(result.images).toHaveLength(1)
    expect(result.costUsd).toBeNull()
  })
})

describe('checkImageModelAvailability', () => {
  function availabilityFetch(responses: { endpoints: Response; key: Response }): { fetchImpl: FetchFunction; calls: Array<{ url: string; auth: string | null }> } {
    const calls: Array<{ url: string; auth: string | null }> = []
    const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      calls.push({ url: String(url), auth: headers.get('authorization') })
      return String(url).endsWith('/key') ? responses.key : responses.endpoints
    }) as unknown as FetchFunction
    return { fetchImpl, calls }
  }

  const liveEndpoints = () => jsonResponse({
    data: { id: 'recraft/recraft-v4.1-vector', architecture: { output_modalities: ['image'] }, endpoints: [{ name: 'Recraft' }] },
  })

  it('checks the model endpoints without auth and the key with auth', async () => {
    const { fetchImpl, calls } = availabilityFetch({ endpoints: liveEndpoints(), key: jsonResponse({ data: { label: 'x' } }) })
    const result = await checkImageModelAvailability(openRouterProvider({ degradedThresholdMs: 60_000 }), 'recraft/recraft-v4.1-vector', { fetchImpl })

    expect(result.status).toBe('healthy')
    expect(result.latencyMs).toEqual(expect.any(Number))
    expect(calls).toContainEqual({ url: 'https://openrouter.ai/api/v1/models/recraft/recraft-v4.1-vector/endpoints', auth: null })
    expect(calls).toContainEqual({ url: 'https://openrouter.ai/api/v1/key', auth: 'Bearer test-key' })
  })

  it('reports a rejected key', async () => {
    const { fetchImpl } = availabilityFetch({ endpoints: liveEndpoints(), key: jsonResponse({ error: 'no' }, 401) })
    const result = await checkImageModelAvailability(openRouterProvider(), 'recraft/recraft-v4.1', { fetchImpl })
    expect(result).toMatchObject({ status: 'down', errorMessage: 'API key rejected (HTTP 401)' })
  })

  it('reports unknown models, models without endpoints and non-image models', async () => {
    const key = () => jsonResponse({ data: {} })
    const notFound = await checkImageModelAvailability(openRouterProvider(), 'vendor/missing', {
      fetchImpl: availabilityFetch({ endpoints: jsonResponse({ error: 'not found' }, 404), key: key() }).fetchImpl,
    })
    expect(notFound.errorMessage).toMatch(/not available on OpenRouter/)

    const noEndpoints = await checkImageModelAvailability(openRouterProvider(), 'recraft/recraft-v4.1', {
      fetchImpl: availabilityFetch({ endpoints: jsonResponse({ data: { architecture: { output_modalities: ['image'] }, endpoints: [] } }), key: key() }).fetchImpl,
    })
    expect(noEndpoints.errorMessage).toMatch(/no live endpoints/)

    const textOnly = await checkImageModelAvailability(openRouterProvider(), 'recraft/recraft-v4.1', {
      fetchImpl: availabilityFetch({ endpoints: jsonResponse({ data: { architecture: { output_modalities: ['text'] }, endpoints: [{}] } }), key: key() }).fetchImpl,
    })
    expect(textOnly.errorMessage).toMatch(/does not generate images/)
  })

  it('marks slow checks as degraded', async () => {
    const { fetchImpl } = availabilityFetch({ endpoints: liveEndpoints(), key: jsonResponse({ data: {} }) })
    const result = await checkImageModelAvailability(openRouterProvider({ degradedThresholdMs: -1 }), 'recraft/recraft-v4.1', { fetchImpl })
    expect(result.status).toBe('degraded')
  })
})

describe('resolveImageModel', () => {
  const openRouter = openRouterProvider()
  const second = openRouterProvider({ id: 'or-2', name: 'Second', enabledImageModels: ['recraft/recraft-v4.1'] })
  const entries: UsableImageModel[] = [
    { provider: openRouter, modelId: 'recraft/recraft-v4.1' },
    { provider: openRouter, modelId: 'google/gemini-3.1-flash-image' },
    { provider: second, modelId: 'recraft/recraft-v4.1' },
  ]

  it('uses the Settings default and falls back to the first model when it is unusable', () => {
    expect(resolveImageModel(undefined, entries, 'or-1:google/gemini-3.1-flash-image')).toMatchObject({ ok: true, modelId: 'google/gemini-3.1-flash-image' })
    expect(resolveImageModel('', entries, 'gone:model')).toMatchObject({ ok: true, provider: openRouter, modelId: 'recraft/recraft-v4.1' })
  })

  it('accepts provider id or name prefixes and unique bare ids', () => {
    expect(resolveImageModel('or-2:recraft/recraft-v4.1', entries, '')).toMatchObject({ ok: true, provider: second })
    expect(resolveImageModel('second:recraft/recraft-v4.1', entries, '')).toMatchObject({ ok: true, provider: second })
    expect(resolveImageModel('google/gemini-3.1-flash-image', entries, '')).toMatchObject({ ok: true, provider: openRouter })
  })

  it('rejects ambiguous, unknown and missing models', () => {
    expect(resolveImageModel('recraft/recraft-v4.1', entries, '')).toMatchObject({ ok: false, error: expect.stringMatching(/several providers/) })
    expect(resolveImageModel('vendor/unknown', entries, '')).toMatchObject({ ok: false, error: expect.stringMatching(/not enabled/) })
    expect(resolveImageModel(undefined, [], '')).toMatchObject({ ok: false, error: expect.stringMatching(/No image generation model is enabled/) })
  })
})
