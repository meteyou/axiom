import { describe, expect, it, vi } from 'vitest'
import type { FetchFunction, ImageApi, ImageModel } from '@earendil-works/pi-ai'
import { openAIImageSize, requireImageBackend } from './image-backends.js'

function model(api: ImageApi, id: string, baseUrl: string): ImageModel<ImageApi> {
  return {
    type: 'image',
    id,
    name: id,
    api,
    provider: 'test',
    baseUrl,
    input: ['text', 'image'],
    output: ['image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }
}

const openAI = requireImageBackend('openai-images')
const codex = requireImageBackend('openai-codex-images')
const openRouter = requireImageBackend('openrouter-images')

const gptImage2 = model('openai-images', 'gpt-image-2', 'https://api.openai.com/v1')
const codexImage = model('openai-codex-images', 'gpt-image-2', 'https://chatgpt.com/backend-api/codex')

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function fetchReturning(response: Response): { fetchImpl: FetchFunction; urls: string[]; headers: Headers[] } {
  const urls: string[] = []
  const headers: Headers[] = []
  const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
    urls.push(String(url))
    headers.push(new Headers(init?.headers))
    return response
  }) as unknown as FetchFunction
  return { fetchImpl, urls, headers }
}

function fakeCodexToken(accountId = 'acc-1'): string {
  return `h.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } })).toString('base64url')}.s`
}

const signal = new AbortController().signal

describe('openAIImageSize', () => {
  it('derives exact sizes in multiples of 16 for GPT Image 2 and newer', () => {
    expect(openAIImageSize('gpt-image-2', '1:1')).toEqual({ ok: true, size: '1024x1024' })
    expect(openAIImageSize('gpt-image-2.5-flare', '16:9')).toEqual({ ok: true, size: '1360x768' })
    expect(openAIImageSize('gpt-image-2-2026-04-21', '9:16')).toEqual({ ok: true, size: '768x1360' })
    expect(openAIImageSize('gpt-image-2', '3:1')).toEqual({ ok: true, size: '1776x592' })
  })

  it('rejects ratios outside 1:3 to 3:1 and invalid ratios', () => {
    expect(openAIImageSize('gpt-image-2', '4:1')).toMatchObject({ ok: false, error: expect.stringMatching(/1:3 to 3:1/) })
    expect(openAIImageSize('gpt-image-2', '0:1')).toMatchObject({ ok: false })
  })

  it('maps older and unknown models to the closest fixed size and says so', () => {
    expect(openAIImageSize('gpt-image-1', '3:2')).toEqual({ ok: true, size: '1536x1024' })
    expect(openAIImageSize('gpt-image-1.5', '16:9')).toMatchObject({ ok: true, size: '1536x1024', note: expect.stringMatching(/sent as 1536x1024/) })
    expect(openAIImageSize('chatgpt-image-latest', '9:16')).toMatchObject({ ok: true, size: '1024x1536' })
  })
})

describe('OpenAI image backend', () => {
  it('turns parameters into request fields', () => {
    expect(openAI.prepare(gptImage2, { aspectRatio: '16:9', quality: 'high', background: 'opaque' }))
      .toEqual({ ok: true, payload: { size: '1360x768', quality: 'high', background: 'opaque' }, notes: [] })
    expect(openAI.prepare(gptImage2, {})).toEqual({ ok: true, payload: {}, notes: [] })
  })

  it('refuses transparent backgrounds for models that cannot render them', () => {
    expect(openAI.prepare(gptImage2, { background: 'transparent' })).toMatchObject({ ok: false, error: expect.stringMatching(/transparent/) })
    expect(openAI.prepare(model('openai-images', 'gpt-image-1.5', ''), { background: 'transparent' }))
      .toMatchObject({ ok: true, payload: { background: 'transparent' } })
  })

  it('estimates the cost from text, image input and image output tokens', () => {
    const cost = openAI.extractCost({
      usage: {
        input_tokens: 1491,
        input_tokens_details: { text_tokens: 21, image_tokens: 1470 },
        output_tokens: 1000,
        output_tokens_details: { image_tokens: 1000, text_tokens: 0 },
      },
    }, gptImage2)
    expect(cost).toBeCloseTo((21 * 5 + 1470 * 8 + 1000 * 30) / 1_000_000, 10)
    expect(openAI.extractCost({ usage: { input_tokens: 10, output_tokens: 10 } }, model('openai-images', 'gpt-image-9', ''))).toBeUndefined()
    expect(openAI.extractCost({}, gptImage2)).toBeUndefined()
  })

  it('checks the model with the API key for free', async () => {
    const ok = fetchReturning(jsonResponse({ id: 'gpt-image-2' }))
    expect(await openAI.checkAvailability(gptImage2, 'sk', ok.fetchImpl, signal)).toEqual({ ok: true })
    expect(ok.urls).toEqual(['https://api.openai.com/v1/models/gpt-image-2'])
    expect(ok.headers[0]!.get('authorization')).toBe('Bearer sk')

    expect(await openAI.checkAvailability(gptImage2, 'sk', fetchReturning(jsonResponse({}, 404)).fetchImpl, signal))
      .toEqual({ ok: false, error: 'Model "gpt-image-2" is not available for this API key' })
    expect(await openAI.checkAvailability(gptImage2, 'sk', fetchReturning(jsonResponse({}, 401)).fetchImpl, signal))
      .toEqual({ ok: false, error: 'API key rejected (HTTP 401)' })
  })

  it('lists the image models the key can use in catalog order, with known names and prices', async () => {
    const { fetchImpl } = fetchReturning(jsonResponse({
      data: [{ id: 'gpt-5.5' }, { id: 'gpt-image-1' }, { id: 'gpt-image-2-2026-04-21' }, { id: 'chatgpt-image-latest' }, { id: 'gpt-image-2' }, { id: 'dall-e-3' }],
    }))
    const models = await openAI.listModels!('https://api.openai.com/v1', 'sk', fetchImpl, signal)
    expect(models.map(m => m.id)).toEqual(['gpt-image-2', 'gpt-image-2-2026-04-21', 'gpt-image-1', 'chatgpt-image-latest'])
    expect(models[2]).toEqual({
      id: 'gpt-image-1',
      name: 'GPT Image 1',
      input: ['text', 'image'],
      output: ['image'],
      pricing: { textInput: 5, imageInput: 10, imageOutput: 40 },
    })
    expect(models[1]).toMatchObject({ name: 'GPT Image 2 (2026-04-21)', pricing: { imageOutput: 30 } })
    expect(models[3]).toEqual({ id: 'chatgpt-image-latest', name: 'chatgpt-image-latest', input: ['text', 'image'], output: ['image'] })
  })
})

describe('ChatGPT subscription image backend', () => {
  it('lets the backend pick size and quality and notes ignored parameters', () => {
    expect(codex.prepare(codexImage, {})).toEqual({ ok: true, payload: { size: 'auto', quality: 'auto', background: 'auto' }, notes: [] })
    const prepared = codex.prepare(codexImage, { aspectRatio: '16:9', quality: 'high', background: 'transparent' })
    expect(prepared).toMatchObject({ ok: true, payload: { size: 'auto', quality: 'auto', background: 'transparent' } })
    expect(prepared.ok && prepared.notes[0]).toMatch(/aspect_ratio and quality was ignored/)
  })

  it('costs nothing per image and runs variants one at a time', () => {
    expect(codex.billing).toBe('subscription')
    expect(codex.extractCost({}, codexImage)).toBe(0)
    expect(codex.maxParallel).toBe(1)
    expect(codex.maxInputImages).toBe(5)
    expect(codex.customModels).toBe(false)
  })

  it('summarises the image limit from the response headers', () => {
    expect(codex.describeUsage!({
      'x-codex-active-limit': 'imagegen_premium',
      'x-codex-primary-used-percent': '2',
      'x-codex-primary-window-minutes': '1440',
      'x-codex-primary-reset-after-seconds': '86400',
    })).toBe('ChatGPT image limit: 2% used of the 24 h window, resets in 24 h.')
    expect(codex.describeUsage!({ 'x-codex-primary-used-percent': '2' })).toBeUndefined()
  })

  it('checks plan and usage limit on the free usage endpoint', async () => {
    const ok = fetchReturning(jsonResponse({ plan_type: 'plus', rate_limit: { allowed: true, limit_reached: false } }))
    expect(await codex.checkAvailability(codexImage, fakeCodexToken(), ok.fetchImpl, signal)).toEqual({ ok: true })
    expect(ok.urls).toEqual(['https://chatgpt.com/backend-api/wham/usage'])
    expect(ok.headers[0]!.get('chatgpt-account-id')).toBe('acc-1')

    const free = fetchReturning(jsonResponse({ plan_type: 'free' }))
    expect(await codex.checkAvailability(codexImage, fakeCodexToken(), free.fetchImpl, signal))
      .toEqual({ ok: false, error: 'Image generation is not included in the ChatGPT Free plan.' })
    const limited = fetchReturning(jsonResponse({ plan_type: 'plus', rate_limit: { limit_reached: true } }))
    expect(await codex.checkAvailability(codexImage, fakeCodexToken(), limited.fetchImpl, signal))
      .toMatchObject({ ok: false, error: expect.stringMatching(/usage limit/) })
    const rejected = fetchReturning(jsonResponse({}, 401))
    expect(await codex.checkAvailability(codexImage, fakeCodexToken(), rejected.fetchImpl, signal))
      .toMatchObject({ ok: false, error: expect.stringMatching(/Sign in again/) })
  })
})

describe('OpenRouter image backend', () => {
  it('sends the aspect ratio as image_config and notes unsupported parameters', () => {
    const prepared = openRouter.prepare(model('openrouter-images', 'x', ''), { aspectRatio: '16:9', quality: 'high' })
    expect(prepared).toEqual({
      ok: true,
      payload: { image_config: { aspect_ratio: '16:9' } },
      notes: ['quality is not supported for OpenRouter image models and was ignored.'],
    })
  })

  it('lists image models live with their modalities', async () => {
    const { fetchImpl, urls } = fetchReturning(jsonResponse({
      data: [
        { id: 'vendor/b-image', name: 'B Image', architecture: { input_modalities: ['text', 'image'], output_modalities: ['image', 'text'] } },
        {
          id: 'vendor/a-image',
          name: 'A Image',
          architecture: { input_modalities: ['text'], output_modalities: ['image'] },
          pricing: { prompt: '0', completion: '0', image_token: '0.00000838323353293413', image_output: '0.00000838323353293413' },
        },
        { id: 'vendor/chat', name: 'Chat', architecture: { input_modalities: ['text'], output_modalities: ['text'] } },
      ],
    }))
    const models = await openRouter.listModels!('https://openrouter.ai/api/v1', 'key', fetchImpl, signal)
    expect(urls).toEqual(['https://openrouter.ai/api/v1/models?output_modalities=image'])
    expect(models).toEqual([
      {
        id: 'vendor/a-image',
        name: 'A Image',
        input: ['text'],
        output: ['image'],
        pricing: { textInput: 0, imageInput: 8.383234, imageOutput: 8.383234 },
      },
      { id: 'vendor/b-image', name: 'B Image', input: ['text', 'image'], output: ['image', 'text'] },
    ])
  })
})
