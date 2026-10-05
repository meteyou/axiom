import { describe, expect, it, vi } from 'vitest'
import type { AgentMessage, PrepareNextTurnContext } from '@earendil-works/pi-agent-core'
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai'
import type { TranscriptContext } from '@earendil-works/pi-ai'
import { createAxiomAgent } from './agent-factory.js'
import { ContextCompactor } from './context-compactor.js'
import type { ContextCompactorOptions } from './context-compactor.js'
import { SUMMARIZATION_SYSTEM_PROMPT, findSummaryMessage } from './compaction.js'
import type { CompactionSettingsSource } from './compaction.js'

const SUMMARY_TEXT = '## Goal\n- Finish the report\n\n## Open Threads & Next Steps\n1. Continue'
const CHARS_PER_TOKEN = 4

function isSummaryRequest(context: TranscriptContext): boolean {
  const first = context.messages[0] as { role: string; content: unknown }
  return first?.role === 'system' && first.content === SUMMARIZATION_SYSTEM_PROMPT
}

function text(tokens: number, label: string): string {
  return `${label} ${'x'.repeat(tokens * CHARS_PER_TOKEN)}`
}

let clock = 0

function user(tokens: number): AgentMessage {
  return { role: 'user', content: [{ type: 'text', text: text(tokens, 'question') }], timestamp: ++clock }
}

function assistant(tokens: number): AgentMessage {
  return { ...fauxAssistantMessage(text(tokens, 'answer')), timestamp: ++clock }
}

function toolTurn(id: string, resultTokens: number): AgentMessage[] {
  return [
    { ...fauxAssistantMessage(fauxToolCall('web_fetch', { url: `https://example.com/${id}` }, { id }), { stopReason: 'toolUse' }), timestamp: ++clock },
    { role: 'toolResult', toolCallId: id, toolName: 'web_fetch', content: [{ type: 'text', text: text(resultTokens, 'page') }], isError: false, timestamp: ++clock },
  ]
}

/**
 * 40k window, no soft budget: reserve 10k → trigger 30k, keep 1.5k.
 */
function setup(options: Partial<ContextCompactorOptions> & { settings?: CompactionSettingsSource } = {}) {
  const core = createFauxCore({ models: [{ id: 'small-model', contextWindow: 40_000, maxTokens: 4_000 }] })
  let summaryCalls = 0
  const summarize = (context: TranscriptContext) => {
    expect(isSummaryRequest(context)).toBe(true)
    summaryCalls++
    return fauxAssistantMessage(SUMMARY_TEXT)
  }
  core.setResponses(Array.from({ length: 8 }, () => summarize))

  const onWarning = vi.fn()
  let completed = 0
  const compactor = new ContextCompactor({
    scope: 'task',
    getSessionId: () => 'session-1',
    resolveApiKey: () => 'test-key',
    loadSettings: () => options.settings ?? { maxContextTokens: null, keepRecentTokens: 1_500, tasks: { maxContextTokens: null } },
    onWarning,
    onEvent: info => { if (info.status === 'completed') completed++ },
    ...options,
  })
  const agent = createAxiomAgent({
    initialState: { systemPrompt: 'You are a test agent.', model: core.getModel(), tools: [] },
    getApiKey: () => 'test-key',
    compactor,
    streamFn: (...args) => core.streamSimple(...args),
  })
  return { agent, compactor, onWarning, summaryCalls: () => summaryCalls, compactions: () => completed }
}

function turnContext(messages: AgentMessage[]): PrepareNextTurnContext {
  return { context: { systemPrompt: 'You are a test agent.', messages, tools: [] } } as unknown as PrepareNextTurnContext
}

describe('ContextCompactor', () => {
  it('attaches itself as the between-turn hook of the agent', () => {
    const { agent } = setup()
    expect(agent.prepareNextTurnWithContext).toBeTypeOf('function')
  })

  it('compacts at most once per turn', async () => {
    const { agent, compactor, compactions } = setup()
    const system = agent.state.messages[0]
    const messages = [system, user(4_000), assistant(4_000), user(4_000), assistant(4_000), user(4_000), assistant(4_000), ...toolTurn('t1', 8_000)]
    agent.state.messages = messages

    const first = await compactor.prepareNextTurn(turnContext(messages))
    expect(first?.context?.messages).toBeDefined()
    expect(findSummaryMessage(first!.context!.messages)).not.toBeNull()
    expect(compactions()).toBe(1)

    // Still the same turn: even a large pending prompt does not trigger a second compaction.
    expect(await compactor.compactBeforePrompt(25_000)).toBeNull()
    expect(await compactor.prepareNextTurn(turnContext(agent.state.messages))).toBeUndefined()
    expect(compactions()).toBe(1)

    const nextTurn = [...agent.state.messages, ...toolTurn('t2', 25_000)]
    agent.state.messages = nextTurn
    expect(await compactor.prepareNextTurn(turnContext(nextTurn))).toBeDefined()
    expect(compactions()).toBe(2)
  })

  it('pauses automatic compaction with one warning when the kept tail alone exceeds the trigger', async () => {
    const { agent, compactor, onWarning, summaryCalls } = setup()
    const system = agent.state.messages[0]
    const messages = [system, user(4_000), assistant(4_000), ...toolTurn('big', 31_000)]
    agent.state.messages = messages

    expect(await compactor.prepareNextTurn(turnContext(messages))).toBeDefined()
    expect(summaryCalls()).toBe(1)
    expect(onWarning).toHaveBeenCalledTimes(1)
    expect(onWarning.mock.calls[0]![0]).toContain('could not bring the context below 30000 tokens')

    const nextTurn = [...agent.state.messages, ...toolTurn('t2', 2_000)]
    agent.state.messages = nextTurn
    expect(await compactor.prepareNextTurn(turnContext(nextTurn))).toBeUndefined()
    expect(summaryCalls()).toBe(1)
    expect(onWarning).toHaveBeenCalledTimes(1)

    compactor.reset()
    expect(await compactor.prepareNextTurn(turnContext(agent.state.messages))).toBeDefined()
    expect(summaryCalls()).toBe(2)
  })

  it('stays out of the way below the trigger and when tasks have compaction disabled', async () => {
    const small = setup()
    const shortTranscript = [small.agent.state.messages[0], user(1_000), assistant(1_000)]
    small.agent.state.messages = shortTranscript
    expect(await small.compactor.prepareNextTurn(turnContext(shortTranscript))).toBeUndefined()

    const disabled = setup({ settings: { maxContextTokens: null, tasks: { enabled: false } } })
    const longTranscript = [disabled.agent.state.messages[0], user(20_000), assistant(20_000), user(500)]
    disabled.agent.state.messages = longTranscript
    expect(await disabled.compactor.prepareNextTurn(turnContext(longTranscript))).toBeUndefined()
    expect(disabled.summaryCalls()).toBe(0)
  })
})
