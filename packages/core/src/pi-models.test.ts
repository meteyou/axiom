import { describe, expect, it, vi } from 'vitest'
import type { Api, Model } from '@earendil-works/pi-ai'
import { registerSessionResourceCleanup } from '@earendil-works/pi-ai'
import type { BuiltinProvider } from '@earendil-works/pi-ai/providers/all'
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import { SUPPORTED_APIS, releaseProviderSession, streamSimple } from './pi-models.js'
import { PROVIDER_TYPE_PRESETS } from './provider-config.js'

describe('pi-models api coverage', () => {
  it('implements every preset apiType', () => {
    for (const preset of Object.values(PROVIDER_TYPE_PRESETS)) {
      expect(
        SUPPORTED_APIS.has(preset.apiType as Api),
        `preset "${preset.type}" uses unimplemented api "${preset.apiType}"`,
      ).toBe(true)
    }
  })

  it('implements every wire api the catalog-resolved presets can dispatch to', () => {
    for (const preset of Object.values(PROVIDER_TYPE_PRESETS)) {
      if (!preset.piAiProvider) continue
      if (preset.authMethod !== 'oauth' && !preset.resolveModelsFromCatalog) continue

      for (const model of getBuiltinModels(preset.piAiProvider as BuiltinProvider)) {
        expect(
          SUPPORTED_APIS.has(model.api),
          `catalog model "${preset.piAiProvider}/${model.id}" uses unimplemented api "${model.api}"`,
        ).toBe(true)
      }
    }
  })
})

describe('releaseProviderSession', () => {
  function withCleanupSpy(run: (cleanup: ReturnType<typeof vi.fn>) => void): void {
    const cleanup = vi.fn()
    const unregister = registerSessionResourceCleanup(cleanup)
    try {
      run(cleanup)
    } finally {
      unregister()
    }
  }

  it('forwards the session id to pi-ai session cleanup', () => {
    withCleanupSpy((cleanup) => {
      releaseProviderSession('sess-A')
      expect(cleanup).toHaveBeenCalledWith('sess-A')
    })
  })

  it('never triggers the global cleanup for a missing session id', () => {
    withCleanupSpy((cleanup) => {
      releaseProviderSession(undefined)
      releaseProviderSession(null)
      releaseProviderSession('')
      expect(cleanup).not.toHaveBeenCalled()
    })
  })

  it('swallows cleanup failures', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const unregister = registerSessionResourceCleanup(() => { throw new Error('boom') })
    try {
      expect(() => releaseProviderSession('sess-A')).not.toThrow()
      expect(errSpy).toHaveBeenCalled()
    } finally {
      unregister()
      errSpy.mockRestore()
    }
  })
})

describe('streamSimple over openai-completions', () => {
  const model: Model<Api> = {
    id: 'reasoner',
    name: 'Reasoner',
    api: 'openai-completions',
    provider: 'test-openai-compatible',
    baseUrl: 'http://openai-compatible.test/v1',
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_000,
    maxTokens: 1_000,
  }

  function sseResponse(deltas: Record<string, string>[]): Response {
    const chunks = deltas.map((delta, index) => ({
      id: 'chatcmpl-1',
      object: 'chat.completion.chunk',
      created: 0,
      model: model.id,
      choices: [{ index: 0, delta, finish_reason: index === deltas.length - 1 ? 'stop' : null }],
    }))
    const body = [...chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`), 'data: [DONE]\n\n'].join('')
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  }

  it('streams a reasoning tail that shares a chunk with the first answer text before that text', async () => {
    const fetch = vi.fn(async () => sseResponse([
      { reasoning_content: 'answer in' },
      { reasoning_content: ' German.\n', content: '\n\npong' },
      { content: '!' },
    ]))

    const stream = streamSimple(model, { messages: [{ role: 'user', content: 'ping', timestamp: 0 }] }, { apiKey: 'test-key', fetch })
    const deltas: string[] = []
    for await (const event of stream) {
      if (event.type === 'thinking_delta' || event.type === 'text_delta') deltas.push(`${event.type}:${event.delta}`)
    }
    const message = await stream.result()

    expect(deltas).toEqual(['thinking_delta:answer in', 'thinking_delta: German.\n', 'text_delta:\n\npong', 'text_delta:!'])
    expect(message.content).toMatchObject([
      { type: 'thinking', thinking: 'answer in German.\n' },
      { type: 'text', text: '\n\npong!' },
    ])
  })
})
