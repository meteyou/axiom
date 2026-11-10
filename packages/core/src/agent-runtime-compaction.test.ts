import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { createFauxCore, fauxAssistantMessage } from '@earendil-works/pi-ai'
import type { AssistantMessage, TranscriptContext } from '@earendil-works/pi-ai'
import { createAgentRuntime } from './agent-runtime.js'
import type { AgentRuntimePiAgentAccess } from './agent-runtime.js'
import type { ResponseChunk } from './agent-runtime-types.js'
import { initDatabase } from './database.js'
import { SUMMARIZATION_SYSTEM_PROMPT, findSummaryMessage } from './compaction.js'
import { listContextCompactions } from './compaction-store.js'
import { assembleSystemPromptWithSections } from './memory.js'
import { loadConfig } from './config.js'

const faux = vi.hoisted(() => ({
  core: null as ReturnType<typeof createFauxCore> | null,
}))

vi.mock('./provider-config.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>
  return {
    ...original,
    buildStreamFn: vi.fn(() => (...args: Parameters<ReturnType<typeof createFauxCore>['streamSimple']>) =>
      faux.core!.streamSimple(...args)),
    loadModelCompactionOverride: vi.fn(() => undefined),
  }
})

vi.mock('./memory.js', () => ({
  ensureMemoryStructure: vi.fn(),
  ensureConfigStructure: vi.fn(),
  assembleSystemPromptWithSections: vi.fn(() => ({ prompt: 'runtime system prompt', sections: [] })),
  formatCurrentTimeContext: vi.fn(() => ''),
}))

vi.mock('./config.js', () => ({
  ensureConfigTemplates: vi.fn(),
  getConfigDir: vi.fn(() => '/tmp/axiom-agent-runtime-compaction-test-config'),
  warnConfigReadFailed: vi.fn(),
  loadConfig: vi.fn(() => ({
    retry: { enabled: false },
    compaction: { keepRecentTokens: 1_500 },
  })),
}))

vi.mock('./skill-config.js', () => ({ loadSkills: vi.fn(() => ({ skills: [] })), getSkillDecrypted: vi.fn() }))
vi.mock('./stt.js', () => ({ loadSttSettings: vi.fn(() => ({ enabled: false })) }))
vi.mock('./web-tools.js', () => ({ createBuiltinWebTools: vi.fn(() => []) }))
vi.mock('./agent-skills.js', () => ({
  createAgentSkillTools: vi.fn(() => []),
  getAgentSkillsForPrompt: vi.fn(() => []),
  getAgentSkillsCount: vi.fn(() => 0),
  getAgentSkillsDir: vi.fn(() => '/tmp/skills-agent'),
  trackAgentSkillUsage: vi.fn(),
  currentPlatform: vi.fn(() => 'linux'),
}))

const OVERFLOW_ERROR = 'prompt is too long: 210000 tokens > 200000 maximum'
const SUMMARY_TEXT = '## Goal\n- Keep chatting\n\n## Open Threads & Next Steps\n1. Answer the next question'

type Step = (context: TranscriptContext, options: { signal?: AbortSignal } | undefined) => AssistantMessage | Promise<AssistantMessage>

function isSummaryRequest(context: TranscriptContext): boolean {
  const first = context.messages[0] as { role: string; content: unknown }
  return first?.role === 'system' && first.content === SUMMARIZATION_SYSTEM_PROMPT
}

function promptOf(context: TranscriptContext): string {
  const user = context.messages.find(message => message.role === 'user') as { content: string | Array<{ text?: string }> }
  return typeof user.content === 'string' ? user.content : user.content.map(block => block.text ?? '').join('')
}

function history(): AgentMessage[] {
  const messages: AgentMessage[] = []
  for (let i = 0; i < 4; i++) {
    messages.push({ role: 'user', content: [{ type: 'text', text: `question ${i} ${'q'.repeat(4_000)}` }], timestamp: i * 10 + 1 })
    messages.push({ ...fauxAssistantMessage(`answer ${i} ${'a'.repeat(4_000)}`), timestamp: i * 10 + 2 })
  }
  return messages
}

async function drain(stream: AsyncIterable<ResponseChunk>): Promise<ResponseChunk[]> {
  const chunks: ResponseChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function setup(steps: Step[]) {
  faux.core = createFauxCore({ models: [{ id: 'faux-model', contextWindow: 200_000, maxTokens: 4_000 }] })
  faux.core.setResponses(steps.map(step => (context, options) => step(context, options)))
  const db = initDatabase(':memory:')
  const runtime = createAgentRuntime({ model: faux.core.getModel(), apiKey: 'test-key', db, systemPrompt: 'You are Axiom.' })
  const agent = (runtime as unknown as AgentRuntimePiAgentAccess).getAgent()
  agent.state.messages = [agent.state.messages[0], ...history()]
  return { runtime, agent, db, core: faux.core }
}

const overflow: Step = () => fauxAssistantMessage('', { stopReason: 'error', errorMessage: OVERFLOW_ERROR })
const summary: Step = (context) => {
  expect(isSummaryRequest(context)).toBe(true)
  return fauxAssistantMessage(SUMMARY_TEXT)
}

describe('AgentRuntime context compaction', () => {
  beforeEach(() => {
    faux.core = null
  })

  it('compacts and retries exactly once when the provider reports a context overflow', async () => {
    const { runtime, agent, db, core } = setup([
      overflow,
      summary,
      (context) => {
        expect(isSummaryRequest(context)).toBe(false)
        return fauxAssistantMessage('fresh answer')
      },
    ])

    const chunks = await drain(runtime.streamPrompt('next question', 'session-1'))

    expect(core.state.callCount).toBe(3)
    expect(chunks.filter(chunk => chunk.type === 'error')).toEqual([])
    expect(chunks.filter(chunk => chunk.type === 'text').map(chunk => chunk.text).join('')).toBe('fresh answer')
    // The retried answer reports the real context size, which replaces the estimate.
    const finished = chunks.filter(chunk => chunk.type === 'compaction' && chunk.compaction?.status !== 'running')
    expect(finished.map(chunk => [chunk.compaction?.status, chunk.compaction?.reason, chunk.compaction?.tokensAfterMeasured]))
      .toEqual([['completed', 'overflow', undefined], ['completed', 'overflow', true]])
    expect(finished[1]!.compaction!.compactionId).toBe(finished[0]!.compaction!.compactionId)
    expect(chunks.filter(chunk => chunk.type === 'done')).toHaveLength(1)

    expect(findSummaryMessage(agent.state.messages)?.summary).toContain('## Goal')
    expect(agent.state.messages.some(m => m.role === 'assistant' && m.stopReason === 'error')).toBe(false)
    const records = listContextCompactions(db, 'session-1')
    expect(records).toHaveLength(1)
    expect(records[0]!.tokensAfter).toBe(finished[1]!.compaction!.tokensAfter)
    const usage = db.prepare('SELECT COUNT(*) AS n FROM token_usage WHERE session_id = ?').get('session-1') as { n: number }
    expect(usage.n).toBeGreaterThanOrEqual(2)
  })

  it('does not retry a second time and reports a context_overflow error', async () => {
    const { runtime, core } = setup([overflow, summary, overflow, () => fauxAssistantMessage('never reached')])

    const chunks = await drain(runtime.streamPrompt('next question', 'session-2'))

    expect(core.state.callCount).toBe(3)
    const errors = chunks.filter(chunk => chunk.type === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0].error).toContain('compacting once did not help')
    expect(errors[0].error).toContain(OVERFLOW_ERROR)
    expect(errors[0].errorCause).toBe('context_overflow')
  })

  it('compacts on /compact and passes the instructions to the summary', async () => {
    let prompt = ''
    const { runtime, agent } = setup([(context) => {
      prompt = promptOf(context)
      return fauxAssistantMessage(SUMMARY_TEXT)
    }])

    const chunks = await drain(runtime.compact('keep the PR numbers', 'session-3'))

    expect(prompt).toContain('Additional focus: keep the PR numbers')
    expect(chunks.at(-1)?.compaction).toMatchObject({ status: "completed", reason: "manual" })
    expect(chunks.at(-1)?.compaction?.tokensAfter).toBeLessThan(chunks.at(-1)!.compaction!.tokensBefore)
    expect(findSummaryMessage(agent.state.messages)).not.toBeNull()
  })

  const answer: Step = () => fauxAssistantMessage('answer')

  /** Runs a whole turn on `channel` and returns the channel prefix its message carried. */
  async function turnPrefix(runtime: ReturnType<typeof setup>['runtime'], channel: 'web' | 'telegram'): Promise<string | null> {
    const { prefix } = runtime.getTurnContext(channel)
    await drain(runtime.streamPrompt(`${prefix ?? ''}short question`, 'session-turn'))
    return prefix
  }

  it('announces the current channel again after compaction rebuilt the snapshot', async () => {
    const { runtime } = setup([answer, answer, summary])
    expect(await turnPrefix(runtime, 'telegram')).toContain('through Telegram')
    expect(await turnPrefix(runtime, 'telegram')).toBeNull()

    await drain(runtime.compact(undefined, 'session-3b'))

    expect(runtime.getTurnContext('telegram').prefix).toContain('through Telegram')
  })

  it('still announces the switch back to web after compaction during a Telegram conversation', async () => {
    const { runtime } = setup([answer, summary, answer])
    await turnPrefix(runtime, 'telegram')

    await drain(runtime.compact(undefined, 'session-3c'))

    expect(await turnPrefix(runtime, 'web')).toContain('switched from Telegram')
    expect(runtime.getTurnContext('web').prefix).toBeNull()
  })

  it('does not repeat the channel prefix when the announcing prompt itself triggered compaction', async () => {
    const { runtime, agent } = setup([summary, () => fauxAssistantMessage('answer')])
    agent.state.model = { ...agent.state.model, contextWindow: 10_000 }
    const context = runtime.getTurnContext('telegram')

    await drain(runtime.streamPrompt(`${context.prefix}\n\nshort question`, 'session-3d'))

    expect(findSummaryMessage(agent.state.messages)).not.toBeNull()
    expect(runtime.getTurnContext('telegram').prefix).toBeNull()
  })

  it('leaves the transcript untouched when the summary call is aborted', async () => {
    let runtimeRef: ReturnType<typeof setup>['runtime'] | null = null
    const { runtime, agent } = setup([async () => {
      runtimeRef!.abort()
      return fauxAssistantMessage(SUMMARY_TEXT)
    }])
    runtimeRef = runtime
    const before = agent.state.messages.slice()

    const chunks = await drain(runtime.compact(undefined, 'session-4'))

    expect(chunks.at(-1)?.compaction).toMatchObject({ status: 'failed', error: 'Compaction aborted' })
    expect(agent.state.messages).toEqual(before)
  })

  it('compacts before a prompt that would cross the threshold', async () => {
    const { runtime, agent, core } = setup([summary, () => fauxAssistantMessage('answer')])
    agent.state.model = { ...agent.state.model, contextWindow: 10_000 }

    const chunks = await drain(runtime.streamPrompt('short question', 'session-5'))

    expect(core.state.callCount).toBe(2)
    expect(chunks.find(chunk => chunk.compaction?.status === 'completed')?.compaction?.reason).toBe('threshold')
    expect(findSummaryMessage(agent.state.messages)).not.toBeNull()
  })

  describe('session snapshot', () => {
    const baseConfig = { retry: { enabled: false }, compaction: { keepRecentTokens: 1_500 } }

    function systemMessagesOf(messages: readonly unknown[]): Array<{ content: unknown; toolsAdded?: Array<{ name: string }> }> {
      return (messages as Array<{ role: string }>).filter(message => message.role === 'system') as never
    }

    function setupBuiltPrompt(steps: Step[]) {
      faux.core = createFauxCore({ models: [{ id: 'faux-model', contextWindow: 200_000, maxTokens: 4_000 }] })
      faux.core.setResponses(steps.map(step => (context, options) => step(context, options)))
      const runtime = createAgentRuntime({ model: faux.core.getModel(), apiKey: 'test-key', db: initDatabase(':memory:') })
      return { runtime, agent: (runtime as unknown as AgentRuntimePiAgentAccess).getAgent() }
    }

    afterEach(() => {
      vi.mocked(assembleSystemPromptWithSections).mockImplementation(() => ({ prompt: 'runtime system prompt', sections: [] }))
      vi.mocked(loadConfig).mockImplementation(() => baseConfig)
    })

    it('keeps prompt and tools frozen across turns and rebuilds both on compaction', async () => {
      const requests: TranscriptContext[] = []
      const answer = (text: string): Step => (context) => {
        requests.push(context)
        return fauxAssistantMessage(text)
      }
      const { runtime, agent } = setupBuiltPrompt([answer('first'), answer('second'), summary, answer('third')])
      vi.mocked(assembleSystemPromptWithSections).mockImplementation(() => ({ prompt: 'prompt v1', sections: [] }))

      await drain(runtime.streamPrompt('hello', 'session-6'))
      // Memory edits and a codemode toggle mid-session must not reach the running session.
      vi.mocked(assembleSystemPromptWithSections).mockImplementation(() => ({ prompt: 'prompt v2', sections: [] }))
      vi.mocked(loadConfig).mockImplementation(() => ({ ...baseConfig, codemode: { mainAgent: true } }))
      await drain(runtime.streamPrompt('again', 'session-6'))

      const [first, second] = requests.map(context => systemMessagesOf(context.messages))
      expect(first).toHaveLength(1)
      expect(first![0]!.content).toBe('prompt v1')
      expect(second).toEqual(first)
      expect(first![0]!.toolsAdded?.map(tool => tool.name)).not.toContain('codemode')

      agent.state.messages = [...agent.state.messages, ...history()]
      const chunks = await drain(runtime.compact(undefined, 'session-6'))
      expect(chunks.at(-1)?.compaction?.status).toBe('completed')

      const rebuilt = systemMessagesOf(agent.state.messages)
      expect(rebuilt).toHaveLength(1)
      expect(agent.state.messages[0]).toBe(rebuilt[0])
      expect(rebuilt[0]!.content).toBe('prompt v2')
      expect(rebuilt[0]!.toolsAdded?.map(tool => tool.name)).toEqual(agent.state.tools.map(tool => tool.name))
      expect(agent.state.tools.map(tool => tool.name)).toContain('codemode')
      expect(findSummaryMessage(agent.state.messages)).not.toBeNull()

      await drain(runtime.streamPrompt('after compaction', 'session-6'))
      const third = systemMessagesOf(requests[2]!.messages)
      expect(third).toEqual(rebuilt)
    })

    it('starts a fresh snapshot after the session ends', async () => {
      const requests: TranscriptContext[] = []
      const answer: Step = (context) => {
        requests.push(context)
        return fauxAssistantMessage('ok')
      }
      const { runtime } = setupBuiltPrompt([answer, answer])
      vi.mocked(assembleSystemPromptWithSections).mockImplementation(() => ({ prompt: 'prompt v1', sections: [] }))
      await drain(runtime.streamPrompt('hello', 'session-7'))

      vi.mocked(assembleSystemPromptWithSections).mockImplementation(() => ({ prompt: 'prompt v2', sections: [] }))
      runtime.clearMessages()
      await drain(runtime.streamPrompt('new session', 'session-8'))

      const second = requests[1]!.messages
      expect(systemMessagesOf(second).map(message => message.content)).toEqual(['prompt v2'])
      expect(second.filter(message => message.role === 'user')).toHaveLength(1)
    })
  })
})
