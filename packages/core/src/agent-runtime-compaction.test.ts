import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { createFauxCore, fauxAssistantMessage } from '@earendil-works/pi-ai'
import type { AssistantMessage, TranscriptContext } from '@earendil-works/pi-ai'
import { createAgentRuntime } from './agent-runtime.js'
import type { AgentRuntimePiAgentAccess } from './agent-runtime.js'
import type { ResponseChunk } from './agent-runtime-types.js'
import { initDatabase } from './database.js'
import { SUMMARIZATION_SYSTEM_PROMPT, findSummaryMessage } from './compaction.js'
import { listContextCompactions } from './compaction-store.js'
import { isContextOverflowError } from './turn-retry.js'

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
  assembleSystemPrompt: vi.fn(() => 'runtime system prompt'),
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
    const finished = chunks.filter(chunk => chunk.type === 'compaction' && chunk.compaction?.status !== 'running')
    expect(finished.map(chunk => [chunk.compaction?.status, chunk.compaction?.reason])).toEqual([['completed', 'overflow']])
    expect(chunks.filter(chunk => chunk.type === 'done')).toHaveLength(1)

    expect(findSummaryMessage(agent.state.messages)?.summary).toContain('## Goal')
    expect(agent.state.messages.some(m => m.role === 'assistant' && m.stopReason === 'error')).toBe(false)
    expect(listContextCompactions(db, 'session-1')).toHaveLength(1)
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
    expect(isContextOverflowError(errors[0].error!)).toBe(true)
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
})
