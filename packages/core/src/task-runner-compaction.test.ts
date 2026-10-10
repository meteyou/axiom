import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type, createFauxCore, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai'
import type { TranscriptContext } from '@earendil-works/pi-ai'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import { TaskStore } from './task-store.js'
import { TaskRunner } from './task-runner.js'
import { SessionManager } from './session-manager.js'
import type { ProviderConfig } from './provider-config.js'
import { EXTERNAL_ACTIONS_HEADING, SUMMARIZATION_SYSTEM_PROMPT } from './compaction.js'
import { listContextCompactions } from './compaction-store.js'
import { CONTEXT_COMPACTION_KIND } from './contracts/compaction.js'

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
    estimateCost: vi.fn(() => 0),
  }
})

vi.mock('./compaction-diagnostics.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>
  return {
    ...original,
    loadCompactionSettings: vi.fn(() => ({ keepRecentTokens: 1_500, tasks: { maxContextTokens: 20_000 } })),
  }
})

vi.mock('./pi-models.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>
  return { ...original, releaseProviderSession: vi.fn() }
})

const SUMMARY_TEXT = '## Goal\n- Collect the pages and report\n\n## Open Threads & Next Steps\n1. Write the report'
const PAGE_TOKENS = 9_000

const provider: ProviderConfig = {
  id: 'faux-provider-id',
  name: 'faux-provider',
  type: 'openai',
  providerType: 'openai',
  provider: 'openai',
  baseUrl: 'http://localhost:1234',
  apiKey: 'test-key',
  enabledModels: ['faux-model'],
  models: [],
  status: 'connected',
  authMethod: 'api-key',
}

function textTool(name: string, output: () => string): AgentTool {
  return {
    name,
    label: name,
    description: `Test tool ${name}`,
    parameters: Type.Object({ target: Type.String() }),
    execute: async () => ({ content: [{ type: 'text' as const, text: output() }], details: {} }),
  }
}

function isSummaryRequest(context: TranscriptContext): boolean {
  const first = context.messages[0] as { role: string; content: unknown }
  return first?.role === 'system' && first.content === SUMMARIZATION_SYSTEM_PROMPT
}

function contextText(context: TranscriptContext): string {
  return JSON.stringify(context.messages)
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for condition')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

describe('TaskRunner context compaction', () => {
  let db: Database
  let dbPath: string
  let runner: TaskRunner
  let store: TaskStore

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `axiom-task-compaction-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
    db = initDatabase(dbPath)
    store = new TaskStore(db)
  })

  afterEach(() => {
    runner?.dispose()
    db.close()
    fs.rmSync(dbPath, { force: true })
    faux.core = null
  })

  it('compacts between tool turns and finishes the task on the compacted context', async () => {
    faux.core = createFauxCore({ models: [{ id: 'faux-model', contextWindow: 128_000, maxTokens: 4_000 }] })
    const agentRequests: TranscriptContext[] = []
    let agentCalls = 0
    const respond = (context: TranscriptContext) => {
      if (isSummaryRequest(context)) {
        return fauxAssistantMessage(SUMMARY_TEXT)
      }
      agentRequests.push(context)
      agentCalls++
      if (agentCalls === 1) return fauxAssistantMessage(fauxToolCall('email_send', { target: 'stefan@example.com' }, { id: 'mail-1' }), { stopReason: 'toolUse' })
      if (agentCalls <= 4) return fauxAssistantMessage(fauxToolCall('web_fetch', { target: `page-${agentCalls}` }, { id: `fetch-${agentCalls}` }), { stopReason: 'toolUse' })
      return fauxAssistantMessage('STATUS: completed\nSUMMARY: Report written')
    }
    faux.core.setResponses(Array.from({ length: 20 }, () => respond))

    let page = 0
    runner = new TaskRunner({
      db,
      buildModel: () => faux.core!.getModel(),
      getApiKey: async () => 'test-key',
      tools: [
        textTool('email_send', () => 'Email sent to stefan@example.com'),
        textTool('web_fetch', () => `page ${++page} ${'p'.repeat(PAGE_TOKENS * 4)}`),
      ],
      onTaskComplete: () => {},
      sessionManager: new SessionManager({ db }),
    })

    const task = store.create({ name: 'Research', prompt: 'Fetch three pages and report.', triggerType: 'agent' })
    await runner.startTask(task, provider)
    await waitFor(() => store.getById(task.id)?.status !== 'running')

    const finished = store.getById(task.id)!
    expect(finished.status).toBe('completed')
    expect(finished.resultSummary).toBe('Report written')

    const records = listContextCompactions(db, finished.sessionId!)
    // The second compaction no longer sees the email call itself; the action
    // log must carry over from the first summary.
    expect(records).toHaveLength(2)
    for (const record of records) {
      expect(record.scope).toBe('task')
      expect(record.tokensAfter).toBeLessThan(record.tokensBefore)
      expect(record.summary).toContain(EXTERNAL_ACTIONS_HEADING)
      expect(record.summary.match(/- \[done\] email_send \{"target":"stefan@example.com"\}/g)).toHaveLength(1)
    }

    const lastRequest = contextText(agentRequests.at(-1)!)
    expect(lastRequest).toContain('<context_summary>')
    expect(lastRequest).not.toContain('page 1 ')

    const usageRows = db.prepare('SELECT COUNT(*) AS count FROM token_usage WHERE session_id = ?').get(finished.sessionId) as { count: number }
    expect(usageRows.count).toBeGreaterThan(agentCalls)
    // The task's own totals include the summary calls, matching token_usage.
    const totals = db.prepare('SELECT SUM(prompt_tokens) AS prompt, SUM(completion_tokens) AS completion FROM token_usage WHERE session_id = ?')
      .get(finished.sessionId) as { prompt: number; completion: number }
    expect(finished.promptTokens).toBe(totals.prompt)
    expect(finished.completionTokens).toBe(totals.completion)

    const notices = (db.prepare('SELECT metadata FROM chat_messages WHERE session_id = ? AND role = ?').all(finished.sessionId, 'system') as { metadata: string }[])
      .map(row => JSON.parse(row.metadata) as { kind?: string; status?: string })
      .filter(meta => meta.kind === CONTEXT_COMPACTION_KIND)
    expect(notices.map(n => n.status)).toContain('completed')
  })

  function startRunner(respond: (context: TranscriptContext) => ReturnType<typeof fauxAssistantMessage>) {
    faux.core = createFauxCore({ models: [{ id: 'faux-model', contextWindow: 128_000, maxTokens: 4_000 }] })
    faux.core.setResponses(Array.from({ length: 20 }, () => respond))
    runner = new TaskRunner({
      db,
      buildModel: () => faux.core!.getModel(),
      getApiKey: async () => 'test-key',
      tools: [textTool('web_fetch', () => `page ${'p'.repeat(2_000)}`)],
      onTaskComplete: () => {},
      sessionManager: new SessionManager({ db }),
    })
  }

  const OVERFLOW = 'prompt is too long: 210000 tokens > 200000 maximum'

  it('compacts and continues exactly once after a provider context overflow', async () => {
    let agentCalls = 0
    let summaries = 0
    startRunner((context) => {
      if (isSummaryRequest(context)) {
        summaries++
        return fauxAssistantMessage(SUMMARY_TEXT)
      }
      agentCalls++
      if (agentCalls <= 3) return fauxAssistantMessage(fauxToolCall('web_fetch', { target: `p${agentCalls}` }, { id: `f${agentCalls}` }), { stopReason: 'toolUse' })
      if (agentCalls === 4) return fauxAssistantMessage('', { stopReason: 'error', errorMessage: OVERFLOW })
      return fauxAssistantMessage('STATUS: completed\nSUMMARY: Recovered')
    })

    const task = store.create({ name: 'Overflow', prompt: 'Fetch pages.', triggerType: 'agent' })
    await runner.startTask(task, provider)
    await waitFor(() => store.getById(task.id)?.status !== 'running')

    const finished = store.getById(task.id)!
    expect(finished.status).toBe('completed')
    expect(finished.resultSummary).toBe('Recovered')
    expect(agentCalls).toBe(5)
    expect(summaries).toBeGreaterThanOrEqual(1)
    expect(listContextCompactions(db, finished.sessionId!).map(r => r.reason)).toEqual(['overflow'])
  })

  it('fails with a clear message when the overflow cannot be compacted away', async () => {
    let agentCalls = 0
    startRunner((context) => {
      if (isSummaryRequest(context)) return fauxAssistantMessage(SUMMARY_TEXT)
      agentCalls++
      return fauxAssistantMessage('', { stopReason: 'error', errorMessage: OVERFLOW })
    })

    const task = store.create({ name: 'Too big', prompt: 'Do it.', triggerType: 'agent' })
    await runner.startTask(task, provider)
    await waitFor(() => store.getById(task.id)?.status !== 'running')

    const finished = store.getById(task.id)!
    expect(finished.status).toBe('failed')
    expect(finished.errorMessage).toMatch(/context window/i)
    expect(finished.errorMessage).toContain(OVERFLOW)
    expect(agentCalls).toBe(1)
  })
})
