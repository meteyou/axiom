import { describe, expect, it } from 'vitest'
import type { StreamFn } from '@earendil-works/pi-agent-core'
import { createFauxCore, fauxAssistantMessage } from '@earendil-works/pi-ai'
import { createAxiomAgent } from './agent-factory.js'

describe('createAxiomAgent', () => {
  it('sends requests without pi provider attribution', async () => {
    const core = createFauxCore({})
    core.setResponses([fauxAssistantMessage('ok')])
    const identities: unknown[] = []
    const streamFn: StreamFn = (model, context, options) => {
      identities.push(options?.identity)
      return core.streamSimple(model, context, options)
    }
    const agent = createAxiomAgent({
      initialState: { systemPrompt: 'Test.', model: core.getModel(), tools: [] },
      getApiKey: () => 'test-key',
      streamFn,
    })

    await agent.prompt('hi')

    expect(identities).toHaveLength(1)
    expect(identities[0]).toMatchObject({ attribution: null })
  })
})
