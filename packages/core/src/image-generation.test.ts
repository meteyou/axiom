import { describe, expect, it, vi } from 'vitest'
import type { FetchFunction } from '@earendil-works/pi-ai'
import {
  checkImageModelAvailability,
  generateImagesWithProvider,
  getImageProviderCapabilities,
  listLiveImageModels,
  planImageGeneration,
  resolveImageModel,
} from './image-generation.js'
import type { UsableImageModel } from './image-generation.js'
import { IMAGE_GENERATION_MAX_VARIANTS_BOUNDS } from './contracts/settings.js'
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

function openAIProvider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'oa-1',
    name: 'OpenAI',
    type: 'openai-completions',
    providerType: 'openai',
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-test',
    authMethod: 'api-key',
    enabledImageModels: ['gpt-image-2', 'gpt-image-1'],
    ...overrides,
  }
}

function fakeCodexToken(): string {
  return `h.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acc-1' } })).toString('base64url')}.s`
}

// Without stored OAuth credentials the provider's apiKey is used as the token.
function codexProvider(): ProviderConfig {
  return {
    id: 'cx-1',
    name: 'ChatGPT',
    type: 'openai-codex-responses',
    providerType: 'openai-codex',
    provider: 'openai-codex',
    baseUrl: '',
    apiKey: fakeCodexToken(),
    authMethod: 'oauth',
    enabledImageModels: ['gpt-image-2'],
  }
}

function openAIImagesResponse(headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({
    created: 1,
    data: [{ b64_json: PNG_BASE64, generation_id: 'gen-oa' }],
    output_format: 'png',
    usage: {
      input_tokens: 20,
      input_tokens_details: { text_tokens: 20, image_tokens: 0 },
      output_tokens: 1000,
      output_tokens_details: { image_tokens: 1000, text_tokens: 0 },
      total_tokens: 1020,
    },
  }), { status: 200, headers: { 'content-type': 'application/json', ...headers } })
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
      count: 12,
      fetchImpl,
    })
    expect(bodies).toHaveLength(IMAGE_GENERATION_MAX_VARIANTS_BOUNDS.max)
    expect(result.images).toHaveLength(IMAGE_GENERATION_MAX_VARIANTS_BOUNDS.max)
    expect(result.costUsd).toBeCloseTo(0.1)
    expect(result.requests).toHaveLength(IMAGE_GENERATION_MAX_VARIANTS_BOUNDS.max)
    expect(result.requests[0]!.costUsd).toBeCloseTo(0.01)
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

describe('generateImagesWithProvider for OpenAI (API key)', () => {
  it('sends the size for the aspect ratio and estimates the cost from list prices', async () => {
    const { fetchImpl, bodies } = recordingFetch(() => openAIImagesResponse())
    const result = await generateImagesWithProvider({
      provider: openAIProvider(),
      modelId: 'gpt-image-2',
      prompt: 'a fox',
      parameters: { aspectRatio: '16:9', quality: 'high' },
      fetchImpl,
    })

    expect(result.errors).toEqual([])
    expect(result.billing).toBe('estimated')
    expect(result.images).toEqual([{ mimeType: 'image/png', data: PNG_BASE64, generationId: 'gen-oa', costUsd: expect.any(Number) }])
    expect(result.costUsd).toBeCloseTo((20 * 5 + 1000 * 30) / 1_000_000, 10)
    expect(result.usage).toMatchObject({ input: 20, output: 1000 })
    expect(bodies[0]).toEqual({ model: 'gpt-image-2', prompt: 'a fox', size: '1360x768', quality: 'high' })
  })

  it('notes a fixed-size mapping and refuses parameters the model cannot render', async () => {
    const { fetchImpl } = recordingFetch(() => openAIImagesResponse())
    const result = await generateImagesWithProvider({ provider: openAIProvider(), modelId: 'gpt-image-1', prompt: 'p', parameters: { aspectRatio: '16:9' }, fetchImpl })
    expect(result.notes).toEqual([expect.stringMatching(/sent as 1536x1024/)])

    await expect(generateImagesWithProvider({
      provider: openAIProvider(),
      modelId: 'gpt-image-2',
      prompt: 'p',
      parameters: { background: 'transparent' },
      fetchImpl,
    })).rejects.toThrow(/transparent/)
  })
})

describe('generateImagesWithProvider for a ChatGPT subscription (Codex login)', () => {
  it('runs variants one after another, books no cost and reports the image limit', async () => {
    let running = 0
    let maxRunning = 0
    const urls: string[] = []
    const fetchImpl = vi.fn(async (url: unknown) => {
      urls.push(String(url))
      running++
      maxRunning = Math.max(maxRunning, running)
      await new Promise(resolve => setTimeout(resolve, 5))
      running--
      return openAIImagesResponse({
        'x-codex-active-limit': 'imagegen_premium',
        'x-codex-primary-used-percent': '3',
        'x-codex-primary-window-minutes': '1440',
      })
    }) as unknown as FetchFunction

    const result = await generateImagesWithProvider({
      provider: codexProvider(),
      modelId: 'gpt-image-2',
      prompt: 'p',
      parameters: { aspectRatio: '16:9' },
      count: 2,
      fetchImpl,
    })

    expect(result.images).toHaveLength(2)
    expect(maxRunning).toBe(1)
    expect(urls[0]).toBe('https://chatgpt.com/backend-api/codex/images/generations')
    expect(result).toMatchObject({ billing: 'subscription', costUsd: 0, usageNote: 'ChatGPT image limit: 3% used of the 24 h window.' })
    expect(result.notes).toEqual([expect.stringMatching(/aspect_ratio was ignored/)])
  })
})

describe('planImageGeneration', () => {
  it('accepts valid requests and returns the billing and parameter notes', () => {
    expect(planImageGeneration(openAIProvider(), 'gpt-image-1', { aspectRatio: '1:1' }, 1)).toEqual({ ok: true, billing: 'estimated', notes: [] })
    expect(planImageGeneration(codexProvider(), 'gpt-image-2', {}, 5)).toMatchObject({ ok: true, billing: 'subscription' })
  })

  it('rejects too many input images, image input on text-only models and unsupported parameters', () => {
    expect(planImageGeneration(codexProvider(), 'gpt-image-2', {}, 6)).toMatchObject({ ok: false, error: expect.stringMatching(/at most 5 input images/) })
    expect(planImageGeneration(openRouterProvider(), 'recraft/recraft-v4.1-flash', {}, 1)).toMatchObject({ ok: false, error: expect.stringMatching(/does not accept input images/) })
    expect(planImageGeneration(openAIProvider(), 'gpt-image-2', { aspectRatio: '5:1' }, 0)).toMatchObject({ ok: false, error: expect.stringMatching(/1:3 to 3:1/) })
  })
})

describe('image provider capabilities and live model lists', () => {
  it('describes billing, live list and custom ids per provider type', () => {
    expect(getImageProviderCapabilities('openrouter')).toEqual({ billing: 'reported', liveCatalog: true, customModels: true })
    expect(getImageProviderCapabilities('openai')).toEqual({ billing: 'estimated', liveCatalog: true, customModels: true })
    expect(getImageProviderCapabilities('openai-codex')).toEqual({ billing: 'subscription', liveCatalog: false, customModels: false })
    expect(getImageProviderCapabilities('anthropic')).toBeNull()
  })

  it('lists models live with the provider key, or the catalog for providers without a live list', async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse({ data: [{ id: 'gpt-image-2' }, { id: 'gpt-5.5' }] }))
    const live = await listLiveImageModels(openAIProvider(), { fetchImpl: async (url, init) => {
      expect(String(url)).toBe('https://api.openai.com/v1/models')
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer sk-test')
      return fetchImpl(url, { ...init, body: '{}' })
    } })
    expect(live.map(m => m.id)).toEqual(['gpt-image-2'])

    const unused = vi.fn() as unknown as FetchFunction
    expect((await listLiveImageModels(codexProvider(), { fetchImpl: unused })).map(m => m.id)).toEqual(['gpt-image-2'])
    expect(unused).not.toHaveBeenCalled()
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

  it('checks a ChatGPT login on the free usage endpoint', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ plan_type: 'free' })) as unknown as FetchFunction
    const result = await checkImageModelAvailability(codexProvider(), 'gpt-image-2', { fetchImpl })
    expect(result).toMatchObject({ status: 'down', errorMessage: 'Image generation is not included in the ChatGPT Free plan.' })
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
