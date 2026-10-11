import { describe, expect, it, vi } from 'vitest'
import type { AgentMessage, PrepareNextTurnContext, StreamFn } from '@earendil-works/pi-agent-core'
import { createAssistantMessageEventStream, createFauxCore, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai'
import type { TranscriptContext } from '@earendil-works/pi-ai'
import type { ContextCompactionInfo } from './contracts/compaction.js'
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
function setup(options: Partial<ContextCompactorOptions> & { settings?: CompactionSettingsSource; streamFn?: StreamFn } = {}) {
  const core = createFauxCore({ models: [{ id: 'small-model', contextWindow: 40_000, maxTokens: 4_000 }] })
  let summaryCalls = 0
  const summarize = (context: TranscriptContext) => {
    expect(isSummaryRequest(context)).toBe(true)
    summaryCalls++
    return fauxAssistantMessage(SUMMARY_TEXT)
  }
  core.setResponses(Array.from({ length: 8 }, () => summarize))

  const events: ContextCompactionInfo[] = []
  const settings = { current: options.settings ?? { maxContextTokens: null, keepRecentTokens: 1_500, tasks: { maxContextTokens: null } } }
  const compactor = new ContextCompactor({
    scope: 'task',
    getSessionId: () => 'session-1',
    resolveApiKey: () => 'test-key',
    loadSettings: () => settings.current,
    onEvent: info => { events.push(info) },
    ...options,
  })
  const agent = createAxiomAgent({
    initialState: { systemPrompt: 'You are a test agent.', model: core.getModel(), tools: [] },
    getApiKey: () => 'test-key',
    compactor,
    streamFn: options.streamFn ?? ((...args) => core.streamSimple(...args)),
  })
  const finished = () => events.filter(info => info.status !== 'running')
  return {
    agent,
    compactor,
    settings,
    finished,
    summaryCalls: () => summaryCalls,
    compactions: () => finished().filter(info => info.status === 'completed').length,
  }
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
    const onUsage = vi.fn()
    const { agent, compactor, compactions } = setup({ onUsage })
    const system = agent.state.messages[0]
    const messages = [system, user(4_000), assistant(4_000), user(4_000), assistant(4_000), user(4_000), assistant(4_000), ...toolTurn('t1', 8_000)]
    agent.state.messages = messages

    const first = await compactor.prepareNextTurn(turnContext(messages))
    expect(first?.context?.messages).toBeDefined()
    expect(findSummaryMessage(first!.context!.messages)).not.toBeNull()
    expect(compactions()).toBe(1)
    expect(onUsage).toHaveBeenCalledTimes(1)
    expect(onUsage.mock.calls[0]![0].promptTokens).toBeGreaterThan(0)

    // Still the same turn: even a large pending prompt does not trigger a second compaction.
    expect(await compactor.compactBeforePrompt(25_000)).toBeNull()
    expect(await compactor.prepareNextTurn(turnContext(agent.state.messages))).toBeUndefined()
    expect(compactions()).toBe(1)

    const nextTurn = [...agent.state.messages, ...toolTurn('t2', 25_000)]
    agent.state.messages = nextTurn
    expect(await compactor.prepareNextTurn(turnContext(nextTurn))).toBeDefined()
    expect(compactions()).toBe(2)
  })

  it('resumes once newer messages let the cut move past a huge kept message', async () => {
    const { agent, compactor, finished, summaryCalls } = setup()
    agent.state.messages = [agent.state.messages[0], user(4_000), assistant(4_000)]
    const append = (...messages: AgentMessage[]) => {
      agent.state.messages = [...agent.state.messages, ...messages]
      return compactor.prepareNextTurn(turnContext(agent.state.messages))
    }

    expect(await append(...toolTurn('big', 31_000))).toBeDefined()
    expect(finished().at(-1)).toMatchObject({ status: 'completed', warnings: ['auto_paused'] })

    expect(await append(...toolTurn('t2', 500))).toBeDefined()
    expect(summaryCalls()).toBe(2)
    expect(finished().at(-1)!.warnings).toBeUndefined()
    expect(finished().at(-1)!.tokensAfter).toBeLessThan(30_000)
  })

  it('stays paused while system prompt + summary + kept tail cannot fit, until the budget changes', async () => {
    const { agent, compactor, settings, finished, summaryCalls } = setup()
    const bigSystem = { role: 'system', content: text(29_000, 'system'), timestamp: 0 } as AgentMessage
    agent.state.messages = [bigSystem, user(4_000), assistant(4_000)]
    const append = (...messages: AgentMessage[]) => {
      agent.state.messages = [...agent.state.messages, ...messages]
      return compactor.prepareNextTurn(turnContext(agent.state.messages))
    }

    expect(await append(...toolTurn('t1', 2_000))).toBeDefined()
    expect(finished().at(-1)).toMatchObject({ status: 'completed', warnings: ['window_too_small', 'auto_paused'] })

    expect(await append(...toolTurn('t2', 2_000))).toBeUndefined()
    expect(summaryCalls()).toBe(1)

    // Less reserve → trigger 36k: compaction can fit again and resumes without repeating the warnings.
    settings.current = { ...settings.current, reserveTokens: 4_000 }
    expect(await append(...toolTurn('t3', 4_000))).toBeDefined()
    expect(summaryCalls()).toBe(2)
    expect(finished().at(-1)).toMatchObject({ status: 'completed' })
    expect(finished().at(-1)!.warnings).toBeUndefined()
  })

  it('does not announce skipped compactions it was not asked for', async () => {
    const { agent, compactor, finished } = setup()
    agent.state.messages = [agent.state.messages[0], user(31_000)]
    expect(await compactor.compactBeforePrompt()).toBeNull()
    expect(finished()).toEqual([])
  })

  it('gives up on a summary call that never answers', async () => {
    const hanging: StreamFn = (_model, _context, options) => {
      const stream = createAssistantMessageEventStream()
      options?.signal?.addEventListener('abort', () => {
        stream.push({ type: 'error', reason: 'aborted', error: { ...fauxAssistantMessage(''), stopReason: 'aborted' } })
      })
      return stream
    }
    const { agent, compactor, finished } = setup({ streamFn: hanging, keepaliveMs: 5, idleTimeoutMs: 30 })
    agent.state.messages = [agent.state.messages[0], user(4_000), assistant(4_000), user(4_000), assistant(500)]

    expect(await compactor.compactNow({ reason: 'manual' })).toBeNull()
    expect(finished()).toEqual([expect.objectContaining({ status: 'failed', error: expect.stringMatching(/timed out/) })])
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
