import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createAgentRuntime } from './agent-runtime.js'
import type { AgentRuntimePiAgentAccess } from './agent-runtime.js'
import { initDatabase } from './database.js'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { assembleSystemPromptWithSections } from './memory.js'
import { logToolCall } from './token-logger.js'
import { loadConfig } from './config.js'
import { getAgentSkillsForPrompt } from './agent-skills.js'
import { applyTurnContext } from './turn-context.js'

const runtimeHarness = vi.hoisted(() => ({
  promptBehaviors: [] as Array<(agent: { emit: (event: unknown) => void }, text: string) => Promise<void>>,
  promptCalls: [] as string[],
  promptSessionIds: [] as Array<string | undefined>,
  continueCalls: 0,
  runToolCallCalls: [] as Array<{ toolCall: unknown; options: unknown }>,
}))

vi.mock('@earendil-works/pi-agent-core', () => {
  class MockAgent {
    public state: { model: unknown; tools: AgentTool[]; messages: unknown[] }
    public sessionId: string | undefined
    public afterToolCall: unknown
    public transformContext: unknown
    private listeners = new Set<(event: unknown) => void>()

    constructor(options: { initialState: { systemPrompt: string; model: unknown; tools: AgentTool[] }; afterToolCall?: unknown; transformContext?: unknown }) {
      this.afterToolCall = options.afterToolCall
      this.transformContext = options.transformContext
      const { systemPrompt, ...rest } = options.initialState
      this.state = {
        ...rest,
        messages: [{ role: 'system', content: systemPrompt, timestamp: 0 }],
      }
    }

    subscribe(listener: (event: unknown) => void): () => void {
      this.listeners.add(listener)
      return () => this.listeners.delete(listener)
    }

    async prompt(text: string): Promise<void> {
      runtimeHarness.promptCalls.push(text)
      runtimeHarness.promptSessionIds.push(this.sessionId)
      const behavior = runtimeHarness.promptBehaviors.shift()
      if (behavior) {
        await behavior(this, text)
      }
    }

    async continue(): Promise<void> {
      runtimeHarness.continueCalls++
      runtimeHarness.promptSessionIds.push(this.sessionId)
      const behavior = runtimeHarness.promptBehaviors.shift()
      if (behavior) {
        await behavior(this, '<continue>')
      }
    }

    emit(event: unknown): void {
      for (const listener of this.listeners) {
        listener(event)
      }
    }

    abort(): void {}
  }

  return {
    Agent: MockAgent,
    // The codemode tool dispatches nested calls through runToolCall; the mock
    // records the dispatch and answers with a text result so runtime tests
    // can verify the binding without a real provider.
    runToolCall: vi.fn(async (toolCall: unknown, options: unknown) => {
      runtimeHarness.runToolCallCalls.push({ toolCall, options })
      return {
        toolCall,
        result: { content: [{ type: 'text', text: 'nested-tool-ok' }], details: {} },
      }
    }),
  }
})

vi.mock('./memory.js', () => ({
  ensureMemoryStructure: vi.fn(),
  ensureConfigStructure: vi.fn(),
  getMemoryDir: vi.fn(() => '/tmp/test-memory'),
  assembleSystemPromptWithSections: vi.fn(() => ({ prompt: 'runtime system prompt', sections: [] })),
  formatCurrentTimeContext: vi.fn((timezone?: string) => `<current_time>${timezone}</current_time>`),
}))

vi.mock('./config.js', () => ({
  ensureConfigTemplates: vi.fn(),
  getConfigDir: vi.fn(() => '/tmp/axiom-agent-runtime-test-config'),
  loadConfig: vi.fn(() => ({
    language: 'de',
    timezone: 'Europe/Berlin',
    builtinTools: { webSearch: { enabled: true } },
  })),
}))

vi.mock('./skill-config.js', () => ({
  loadSkills: vi.fn(() => ({
    skills: [
      { name: 'Enabled skill', description: 'desc', path: '/skills/enabled', enabled: true },
      { name: 'Disabled skill', description: 'desc', path: '/skills/disabled', enabled: false },
    ],
  })),
  getSkillDecrypted: vi.fn(),
}))

vi.mock('./stt.js', () => ({
  loadSttSettings: vi.fn(() => ({ enabled: true })),
}))

vi.mock('./stt-tool.js', () => ({
  TRANSCRIBE_AUDIO_TOOL_NAME: 'audio_transcribe',
  createTranscribeAudioTools: vi.fn(() => [{ name: 'audio_transcribe', description: '', parameters: {}, execute: vi.fn() }]),
}))

vi.mock('./web-tools.js', () => ({
  createBuiltinWebTools: vi.fn(() => [{ name: 'builtin_web_tool', parameters: {}, execute: vi.fn() }]),
}))

vi.mock('./agent-skills.js', () => ({
  createAgentSkillTools: vi.fn(() => [{ name: 'agent_skill_tool', parameters: {}, execute: vi.fn() }]),
  getAgentSkillsForPrompt: vi.fn(() => [{ name: 'recent skill', description: 'desc', location: '/skills-agent/recent' }]),
  getAgentSkillsCount: vi.fn(() => 1),
  getAgentSkillsDir: vi.fn(() => '/skills-agent'),
  trackAgentSkillUsage: vi.fn(),
  currentPlatform: vi.fn(() => 'linux'),
}))

vi.mock('./memories-tool.js', () => ({
  createSearchMemoriesTool: vi.fn(() => ({ name: 'memory_search', parameters: {}, execute: vi.fn() })),
}))

vi.mock('./provider-config.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>
  return {
    ...original,
    estimateCost: vi.fn(() => 0),
    getApiKeyForProvider: vi.fn().mockResolvedValue('fallback-key'),
    buildModel: vi.fn((provider: { enabledModels?: string[] }) => ({ id: provider.enabledModels?.[0] })),
  }
})

vi.mock('./token-logger.js', () => ({
  logTokenUsage: vi.fn(),
  logToolCall: vi.fn(),
}))

const endTurn = async (agent: { emit: (event: unknown) => void }) => {
  agent.emit({ type: 'agent_end', messages: [] })
}

async function runTurn(
  runtime: ReturnType<typeof createAgentRuntime>,
  session?: Parameters<ReturnType<typeof createAgentRuntime>['streamPrompt']>[3],
): Promise<void> {
  runtimeHarness.promptBehaviors.push(endTurn)
  for await (const _chunk of runtime.streamPrompt('turn', 'session-1', undefined, session)) { /* drain */ }
}

/** Ends the session and runs the first turn of the next one. */
async function startNewSession(runtime: ReturnType<typeof createAgentRuntime>): Promise<void> {
  runtime.clearMessages()
  await runTurn(runtime)
}

function makeModel() {
  return {
    id: 'gpt-4o',
    name: 'GPT-4o',
    api: 'openai-completions' as const,
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    reasoning: false,
    input: ['text' as const, 'image' as const],
    cost: { input: 2.5, output: 10, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
  }
}

describe('AgentRuntime boundary', () => {
  beforeEach(() => {
    runtimeHarness.promptBehaviors = []
    runtimeHarness.promptCalls = []
    runtimeHarness.promptSessionIds = []
    runtimeHarness.continueCalls = 0
    runtimeHarness.runToolCallCalls = []
    vi.mocked(assembleSystemPromptWithSections).mockClear()
    vi.mocked(logToolCall).mockClear()
  })

  it('wires tools behind a single runtime boundary', async () => {
    const db = initDatabase(':memory:')
    const customTool = { name: 'custom_tool', parameters: {}, execute: vi.fn() } as unknown as AgentTool

    const runtime = createAgentRuntime({
      model: makeModel(),
      apiKey: 'sk-primary',
      db,
      tools: [customTool],
    })
    await runTurn(runtime)

    const toolNames = runtime.getStateSnapshot().toolNames
    expect(toolNames).toEqual(expect.arrayContaining([
      'custom_tool',
      'memory_search',
      'builtin_web_tool',
      'audio_transcribe',
      'agent_skill_tool',
      'shell',
      'file_read',
      'file_write',
      'file_edit',
      'file_list',
    ]))
  })

  it('describes file_write and file_edit so partial changes prefer file_edit', () => {
    const runtime = createAgentRuntime({ model: makeModel(), apiKey: 'sk-primary', db: initDatabase(':memory:'), tools: [] })
    const tools = (runtime as unknown as AgentRuntimePiAgentAccess).getAgent().state.tools
    expect(tools.find(tool => tool.name === 'file_edit')?.description).toContain('Prefer this over file_write')
    expect(tools.find(tool => tool.name === 'file_write')?.description).toContain('prefer file_edit')
  })

  it('assembles system prompt via runtime boundary with config + skills context', async () => {
    const db = initDatabase(':memory:')
    const runtime = createAgentRuntime({
      model: makeModel(),
      apiKey: 'sk-primary',
      db,
      tools: [],
      memoryDir: '/tmp/memory',
      baseInstructions: 'base rules',
    })

    expect(assembleSystemPromptWithSections).not.toHaveBeenCalled()
    await runTurn(runtime, { currentUser: { username: 'alice' } })

    const promptCalls = vi.mocked(assembleSystemPromptWithSections).mock.calls
    const latestCall = promptCalls.at(-1)?.[0]
    expect(latestCall).toBeDefined()
    expect(latestCall?.language).toBe('de')
    expect(latestCall?.timezone).toBe('Europe/Berlin')
    expect(latestCall?.currentUser).toEqual({ username: 'alice' })
    expect(latestCall?.skills).toEqual(expect.arrayContaining([
      { name: 'Enabled skill', description: 'desc', location: '/skills/enabled' },
      { name: 'recent skill', description: 'desc', location: '/skills-agent/recent' },
    ]))
    expect(latestCall?.recentDays).toBeUndefined()
  })

  it('omits daily notes from the prompt of callers without a user row', async () => {
    const runtime = createAgentRuntime({ model: makeModel(), apiKey: 'sk-primary', db: initDatabase(':memory:'), tools: [], user: null, sessionUser: 'telegram-42' })
    await runTurn(runtime)
    expect(vi.mocked(assembleSystemPromptWithSections).mock.calls.at(-1)?.[0]?.recentDays).toBe(0)
  })

  describe('turn context', () => {
    type Runtime = ReturnType<typeof createAgentRuntime>
    type Channel = 'web' | 'telegram'
    const newRuntime = () => createAgentRuntime({ model: makeModel(), apiKey: 'sk-primary', db: initDatabase(':memory:'), tools: [] })
    const drain = async (stream: AsyncIterable<unknown>) => {
      for await (const _chunk of stream) { /* drain */ }
    }

    /** Runs a whole turn on `channel` and returns the channel prefix its message carried. */
    async function turnPrefix(runtime: Runtime, channel: Channel): Promise<string | null> {
      const context = runtime.getTurnContext(channel)
      runtimeHarness.promptBehaviors.push(endTurn)
      await drain(runtime.streamPrompt(applyTurnContext('turn', context), 'session-1'))
      return context.prefix
    }

    function compactorOf(runtime: Runtime) {
      return (runtime as unknown as {
        compactor: { compactBeforePrompt: () => Promise<void>; options: { rebuildSystemMessage: () => unknown } }
      }).compactor
    }

    it('announces Telegram on the first turn but stays silent for web', async () => {
      expect(await turnPrefix(newRuntime(), 'telegram')).toContain('through Telegram')
      expect(await turnPrefix(newRuntime(), 'web')).toBeNull()
    })

    it('announces each channel switch exactly once and nothing while the channel is unchanged', async () => {
      const runtime = newRuntime()

      expect(await turnPrefix(runtime, 'web')).toBeNull()
      expect(await turnPrefix(runtime, 'telegram')).toContain('through Telegram')
      expect(await turnPrefix(runtime, 'telegram')).toBeNull()
      expect(await turnPrefix(runtime, 'web')).toContain('web interface')
      expect(await turnPrefix(runtime, 'web')).toBeNull()
    })

    it('announces the channel again when the turn was stopped before its message was added', async () => {
      const runtime = newRuntime()
      vi.spyOn(compactorOf(runtime), 'compactBeforePrompt').mockImplementationOnce(async () => runtime.abort())

      const context = runtime.getTurnContext('telegram')
      await drain(runtime.streamPrompt(applyTurnContext('stopped', context), 'session-1'))

      expect(context.prefix).toContain('through Telegram')
      expect(runtimeHarness.promptCalls).toEqual([])
      expect(await turnPrefix(runtime, 'telegram')).toContain('through Telegram')
      expect(await turnPrefix(runtime, 'telegram')).toBeNull()
    })

    it('keeps the channel state when a retry continues the transcript without adding its message', async () => {
      const runtime = newRuntime()
      expect(await turnPrefix(runtime, 'telegram')).toContain('through Telegram')
      const piAgent = (runtime as unknown as AgentRuntimePiAgentAccess).getAgent()
      piAgent.state.messages = [...piAgent.state.messages, { role: 'user', content: 'hello', timestamp: 1 }] as never

      const context = runtime.getTurnContext('web')
      runtimeHarness.promptBehaviors.push(endTurn)
      await drain(runtime.retryLastTurn(applyTurnContext('hello', context), 'session-1'))

      expect(runtimeHarness.continueCalls).toBe(1)
      expect(await turnPrefix(runtime, 'web')).toContain('web interface')
    })

    it('announces Telegram again after a compaction unless the pending message already carries it', async () => {
      const runtime = newRuntime()
      const compactor = compactorOf(runtime)
      const compactBeforeNextPrompt = () => vi.spyOn(compactor, 'compactBeforePrompt')
        .mockImplementationOnce(async () => { compactor.options.rebuildSystemMessage() })
      expect(await turnPrefix(runtime, 'telegram')).toContain('through Telegram')

      compactBeforeNextPrompt()
      expect(await turnPrefix(runtime, 'telegram')).toBeNull()
      expect(await turnPrefix(runtime, 'telegram')).toContain('through Telegram')

      expect(await turnPrefix(runtime, 'web')).toContain('web interface')
      compactBeforeNextPrompt()
      expect(await turnPrefix(runtime, 'telegram')).toContain('through Telegram')
      expect(await turnPrefix(runtime, 'telegram')).toBeNull()
    })

    it('appends the current time in the configured timezone', () => {
      const runtime = createAgentRuntime({ model: makeModel(), apiKey: 'sk-primary', db: initDatabase(':memory:'), tools: [] })
      expect(runtime.getTurnContext('web').suffix).toBe('<current_time>Europe/Berlin</current_time>')
    })

    it('treats the first turn after session end as a first turn again', async () => {
      const runtime = newRuntime()
      expect(await turnPrefix(runtime, 'telegram')).not.toBeNull()

      runtime.clearMessages()
      expect(await turnPrefix(runtime, 'telegram')).not.toBeNull()
      runtime.clearMessages()
      expect(await turnPrefix(runtime, 'web')).toBeNull()
    })
  })

  describe('session snapshot', () => {
    function piAgentOf(runtime: ReturnType<typeof createAgentRuntime>) {
      return (runtime as unknown as AgentRuntimePiAgentAccess).getAgent()
    }

    function systemMessages(runtime: ReturnType<typeof createAgentRuntime>) {
      return (piAgentOf(runtime).state.messages as Array<{ role: string }>).filter(message => message.role === 'system')
    }

    it('builds the prompt and tools on the first turn and keeps them byte-identical for the session', async () => {
      const runtime = createAgentRuntime({ model: makeModel(), apiKey: 'sk-primary', db: initDatabase(':memory:'), tools: [] })
      const piAgent = piAgentOf(runtime)
      vi.mocked(assembleSystemPromptWithSections).mockReturnValueOnce({ prompt: 'session prompt', sections: [] })

      await runTurn(runtime)
      const [systemAfterFirstTurn] = systemMessages(runtime)
      const toolsAfterFirstTurn = piAgent.state.tools
      expect(systemAfterFirstTurn).toMatchObject({ role: 'system', content: 'session prompt' })
      expect((systemAfterFirstTurn as { toolsAdded?: Array<{ name: string }> }).toolsAdded?.map(tool => tool.name))
        .toEqual(toolsAfterFirstTurn.map(tool => tool.name))

      // Memory, skills or settings changing mid-session must not leak into it.
      vi.mocked(assembleSystemPromptWithSections).mockReturnValue({ prompt: 'changed prompt', sections: [] })
      try {
        await runTurn(runtime, { currentUser: { username: 'alice' } })
        await runTurn(runtime)

        expect(assembleSystemPromptWithSections).toHaveBeenCalledTimes(1)
        expect(systemMessages(runtime)).toEqual([systemAfterFirstTurn])
        expect(piAgent.state.tools).toBe(toolsAfterFirstTurn)
      } finally {
        vi.mocked(assembleSystemPromptWithSections).mockReturnValue({ prompt: 'runtime system prompt', sections: [] })
      }
    })

    it('gates skills on the tools the snapshot actually declares', async () => {
      const emailRead = { name: 'email_read', parameters: {}, execute: vi.fn() } as unknown as AgentTool
      const runtime = createAgentRuntime({ model: makeModel(), apiKey: 'sk-primary', db: initDatabase(':memory:'), tools: [emailRead] })
      await runTurn(runtime)

      const activeTools = vi.mocked(getAgentSkillsForPrompt).mock.calls.at(-1)?.[0]?.activeTools
      expect([...activeTools ?? []]).toEqual(piAgentOf(runtime).state.tools.map(tool => tool.name))
      expect(activeTools?.has('email_read')).toBe(true)
      // Not offered by this runtime, so skills requiring them stay hidden.
      expect(activeTools?.has('task_write')).toBe(false)
    })

    it('drops the system message on session end and builds a fresh snapshot in the next session', async () => {
      const runtime = createAgentRuntime({ model: makeModel(), apiKey: 'sk-primary', db: initDatabase(':memory:'), tools: [] })
      const piAgent = piAgentOf(runtime)
      vi.mocked(assembleSystemPromptWithSections).mockReturnValueOnce({ prompt: 'first session', sections: [] })
      await runTurn(runtime)
      piAgent.state.messages = [...piAgent.state.messages, { role: 'user', content: 'hello', timestamp: 1 }] as never

      runtime.clearMessages()
      expect(piAgent.state.messages).toEqual([])

      vi.mocked(assembleSystemPromptWithSections).mockReturnValueOnce({ prompt: 'second session', sections: [] })
      await runTurn(runtime, { currentUser: { username: 'alice' } })
      expect(systemMessages(runtime)).toEqual([expect.objectContaining({ content: 'second session' })])
      expect(vi.mocked(assembleSystemPromptWithSections).mock.calls.at(-1)?.[0]?.currentUser).toEqual({ username: 'alice' })
    })

    it('uses a fixed system prompt as the snapshot prompt', async () => {
      const runtime = createAgentRuntime({ model: makeModel(), apiKey: 'sk-primary', db: initDatabase(':memory:'), tools: [], systemPrompt: 'fixed prompt' })
      await runTurn(runtime)
      expect(systemMessages(runtime)).toEqual([expect.objectContaining({ content: 'fixed prompt' })])
      expect(assembleSystemPromptWithSections).not.toHaveBeenCalled()
    })
  })

  it('orchestrates prompt execution events into runtime response chunks', async () => {
    const db = initDatabase(':memory:')
    const runtime = createAgentRuntime({
      model: makeModel(),
      apiKey: 'sk-primary',
      db,
      tools: [],
    })

    runtimeHarness.promptBehaviors.push(async (agent) => {
      agent.emit({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'Hello' },
      })
      agent.emit({
        type: 'tool_execution_start',
        toolName: 'memory_search',
        toolCallId: 'tool-1',
        args: { query: 'test' },
      })
      agent.emit({
        type: 'tool_execution_end',
        toolName: 'memory_search',
        toolCallId: 'tool-1',
        isError: false,
        result: { matches: [] },
      })
      agent.emit({
        type: 'agent_end',
        messages: [],
      })
    })

    const chunks = [] as Array<{ type: string }>
    for await (const chunk of runtime.streamPrompt('hello', 'session-1')) {
      chunks.push({ type: chunk.type })
    }

    expect(chunks.map(c => c.type)).toEqual(['text', 'tool_call_start', 'tool_call_end', 'done'])
    expect(logToolCall).toHaveBeenCalledTimes(1)
  })

  it('classifies tool results with details.error as failures in chunks and tool_calls log', async () => {
    const db = initDatabase(':memory:')
    const runtime = createAgentRuntime({ model: makeModel(), apiKey: 'sk-primary', db, tools: [] })

    runtimeHarness.promptBehaviors.push(async (agent) => {
      agent.emit({ type: 'tool_execution_start', toolName: 'file_read', toolCallId: 'tool-err', args: { path: 'missing.txt' } })
      agent.emit({
        type: 'tool_execution_end',
        toolName: 'file_read',
        toolCallId: 'tool-err',
        isError: false,
        result: { content: [{ type: 'text', text: 'File not found' }], details: { error: true } },
      })
      agent.emit({ type: 'tool_execution_start', toolName: 'file_read', toolCallId: 'tool-ok', args: { path: 'a.txt' } })
      agent.emit({
        type: 'tool_execution_end',
        toolName: 'file_read',
        toolCallId: 'tool-ok',
        isError: false,
        result: { content: [{ type: 'text', text: 'hello' }], details: {} },
      })
      agent.emit({ type: 'agent_end', messages: [] })
    })

    const errorFlags: Array<boolean | undefined> = []
    for await (const chunk of runtime.streamPrompt('read', 'session-1')) {
      if (chunk.type === 'tool_call_end') errorFlags.push(chunk.toolIsError)
    }

    expect(errorFlags).toEqual([true, false])
    const statuses = vi.mocked(logToolCall).mock.calls.slice(-2).map(call => call[1].status)
    expect(statuses).toEqual(['error', 'success'])
  })

  it('keeps image payloads out of streamed and logged tool results', async () => {
    const db = initDatabase(':memory:')
    const runtime = createAgentRuntime({ model: makeModel(), apiKey: 'sk-primary', db, tools: [] })
    const data = Buffer.alloc(3 * 1024).toString('base64')

    runtimeHarness.promptBehaviors.push(async (agent) => {
      agent.emit({ type: 'tool_execution_start', toolName: 'file_read', toolCallId: 'tool-img', args: { path: 'a.png' } })
      agent.emit({
        type: 'tool_execution_end',
        toolName: 'file_read',
        toolCallId: 'tool-img',
        isError: false,
        result: { content: [{ type: 'text', text: 'Read image file [image/png]' }, { type: 'image', mimeType: 'image/png', data }], details: {} },
      })
      agent.emit({ type: 'agent_end', messages: [] })
    })

    const results: unknown[] = []
    for await (const chunk of runtime.streamPrompt('show me', 'session-1')) {
      if (chunk.type === 'tool_call_end') results.push(chunk.toolResult)
    }

    const redacted = { type: 'image', mimeType: 'image/png', data: '[3 KB image data omitted]' }
    expect(results).toEqual([{ content: [{ type: 'text', text: 'Read image file [image/png]' }, redacted], details: {} }])
    const logged = vi.mocked(logToolCall).mock.calls.at(-1)![1]
    expect(logged.output).not.toContain(data)
    expect(JSON.parse(logged.output).content[1]).toEqual(redacted)
  })

  it('keeps structured content out of streamed and logged tool results', async () => {
    const db = initDatabase(':memory:')
    const runtime = createAgentRuntime({ model: makeModel(), apiKey: 'sk-primary', db, tools: [] })

    runtimeHarness.promptBehaviors.push(async (agent) => {
      agent.emit({ type: 'tool_execution_start', toolName: 'shell', toolCallId: 'tool-shell', args: { command: 'echo hi' } })
      agent.emit({
        type: 'tool_execution_end',
        toolName: 'shell',
        toolCallId: 'tool-shell',
        isError: false,
        result: {
          content: [{ type: 'text', text: 'hi\n' }],
          details: { exitCode: 0 },
          structuredContent: { output: 'hi\n', exit_code: 0 },
        },
      })
      agent.emit({ type: 'agent_end', messages: [] })
    })

    const results: Array<Record<string, unknown>> = []
    for await (const chunk of runtime.streamPrompt('run', 'session-1')) {
      if (chunk.type === 'tool_call_end') results.push(chunk.toolResult as Record<string, unknown>)
    }

    expect(results).toEqual([{ content: [{ type: 'text', text: 'hi\n' }], details: { exitCode: 0 } }])
    const logged = vi.mocked(logToolCall).mock.calls.at(-1)![1]
    expect(logged.output).not.toContain('structuredContent')
    expect(JSON.parse(logged.output)).not.toHaveProperty('structuredContent')
  })

  it('normalizes tool result images before they enter the transcript', async () => {
    const runtime = createAgentRuntime({ model: makeModel(), apiKey: 'sk-primary', db: initDatabase(':memory:'), tools: [] })
    const piAgent = (runtime as unknown as AgentRuntimePiAgentAccess).getAgent() as unknown as {
      afterToolCall: (context: { result: { content: unknown[] } }) => Promise<{ content?: unknown[] } | undefined>
    }

    const override = await piAgent.afterToolCall({
      result: { content: [{ type: 'image', mimeType: 'image/png', data: Buffer.from('not an image').toString('base64') }] },
    })

    expect(override?.content).toEqual([{ type: 'text', text: expect.stringContaining('[Image omitted:') }])
  })

  it('trims older transcript images to the active model request budget', async () => {
    const model = { ...makeModel(), inputLimits: { images: { maxPerRequest: 1 } } }
    const runtime = createAgentRuntime({ model, apiKey: 'sk-primary', db: initDatabase(':memory:'), tools: [] })
    const piAgent = (runtime as unknown as AgentRuntimePiAgentAccess).getAgent() as unknown as {
      transformContext: (messages: unknown[]) => Promise<Array<{ content: unknown[] }>>
    }
    const image = { type: 'image', mimeType: 'image/png', data: 'AAAA' }

    const trimmed = await piAgent.transformContext([
      { role: 'user', content: [image], timestamp: 1 },
      { role: 'user', content: [image], timestamp: 2 },
    ])

    expect(trimmed[0].content).toEqual([{ type: 'text', text: expect.stringContaining('Older image omitted') }])
    expect(trimmed[1].content).toEqual([image])
  })

  it('forwards thinking_delta events as thinking response chunks', async () => {
    const db = initDatabase(':memory:')
    const runtime = createAgentRuntime({
      model: makeModel(),
      apiKey: 'sk-primary',
      db,
      tools: [],
    })

    runtimeHarness.promptBehaviors.push(async (agent) => {
      agent.emit({
        type: 'message_update',
        assistantMessageEvent: { type: 'thinking_delta', delta: 'Hmm,' },
      })
      agent.emit({
        type: 'message_update',
        assistantMessageEvent: { type: 'thinking_delta', delta: ' weighing options.' },
      })
      agent.emit({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'Done.' },
      })
      agent.emit({ type: 'agent_end', messages: [] })
    })

    const chunks = [] as Array<{ type: string; text?: string; thinking?: string }>
    for await (const chunk of runtime.streamPrompt('hello', 'session-1')) {
      chunks.push({ type: chunk.type, text: chunk.text, thinking: chunk.thinking })
    }

    expect(chunks.map(c => c.type)).toEqual(['thinking', 'thinking', 'text', 'done'])
    expect(chunks[0]!.thinking).toBe('Hmm,')
    expect(chunks[1]!.thinking).toBe(' weighing options.')
    expect(chunks[2]!.text).toBe('Done.')
  })

  it('surfaces a provider error message as an error chunk instead of ending silently', async () => {
    const db = initDatabase(':memory:')
    const runtime = createAgentRuntime({
      model: makeModel(),
      apiKey: 'sk-primary',
      db,
      tools: [],
    })

    // pi-agent-core reports auth failures (expired key, failed OAuth refresh)
    // as an assistant message with `stopReason: 'error'` — it never throws.
    runtimeHarness.promptBehaviors.push(async (agent) => {
      agent.emit({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [],
          provider: 'openai',
          model: 'gpt-4o',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
          stopReason: 'error',
          errorMessage: '401 Unauthorized: token refresh failed',
        },
      })
      agent.emit({ type: 'agent_end', messages: [] })
    })

    const chunks = [] as Array<{ type: string; error?: string }>
    for await (const chunk of runtime.streamPrompt('hello', 'session-1')) {
      chunks.push({ type: chunk.type, error: chunk.error })
    }

    expect(chunks.map(c => c.type)).toEqual(['error', 'done'])
    expect(chunks[0]!.error).toBe('401 Unauthorized: token refresh failed')
  })

  it('does not report a user abort as an error', async () => {
    const db = initDatabase(':memory:')
    const runtime = createAgentRuntime({
      model: makeModel(),
      apiKey: 'sk-primary',
      db,
      tools: [],
    })

    runtimeHarness.promptBehaviors.push(async (agent) => {
      agent.emit({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [],
          provider: 'openai',
          model: 'gpt-4o',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
          stopReason: 'aborted',
        },
      })
      agent.emit({ type: 'agent_end', messages: [] })
    })

    const chunks = [] as Array<{ type: string }>
    for await (const chunk of runtime.streamPrompt('hello', 'session-1')) {
      chunks.push({ type: chunk.type })
    }

    expect(chunks.map(c => c.type)).toEqual(['done'])
  })

  it('retries the failed turn by continuing the transcript instead of re-sending the user message', async () => {
    const db = initDatabase(':memory:')
    const runtime = createAgentRuntime({
      model: makeModel(),
      apiKey: 'sk-primary',
      db,
      tools: [],
    })

    const piAgent = (runtime as unknown as AgentRuntimePiAgentAccess).getAgent()
    piAgent.state.messages = [
      { role: 'system', content: 'prompt', timestamp: 0 },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [], stopReason: 'error', errorMessage: '429' },
    ] as never

    runtimeHarness.promptBehaviors.push(async (agent) => {
      agent.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Second try.' } })
      agent.emit({ type: 'agent_end', messages: [] })
    })

    const chunks = [] as Array<{ type: string; text?: string }>
    for await (const chunk of runtime.retryLastTurn('hello', 'session-1')) {
      chunks.push({ type: chunk.type, text: chunk.text })
    }

    expect(chunks.map(c => c.type)).toEqual(['text', 'done'])
    expect(runtimeHarness.continueCalls).toBe(1)
    expect(runtimeHarness.promptCalls).toEqual([])
    // The failed assistant message is gone; the user message is not duplicated.
    expect((piAgent.state.messages as Array<{ role: string }>).map(m => m.role)).toEqual(['system', 'user'])
  })

  it('falls back to a fresh prompt when the transcript has nothing to continue from', async () => {
    const db = initDatabase(':memory:')
    const runtime = createAgentRuntime({
      model: makeModel(),
      apiKey: 'sk-primary',
      db,
      tools: [],
    })

    runtimeHarness.promptBehaviors.push(async (agent) => {
      agent.emit({ type: 'agent_end', messages: [] })
    })

    for await (const _chunk of runtime.retryLastTurn('hello', 'session-1')) { /* drain */ }

    expect(runtimeHarness.continueCalls).toBe(0)
    expect(runtimeHarness.promptCalls).toEqual(['hello'])
  })

  it('forwards the per-prompt session id to the pi agent for provider prompt caching', async () => {
    const db = initDatabase(':memory:')
    const runtime = createAgentRuntime({
      model: makeModel(),
      apiKey: 'sk-primary',
      db,
      tools: [],
    })
    const piAgent = (runtime as unknown as AgentRuntimePiAgentAccess).getAgent()

    runtimeHarness.promptBehaviors.push(endTurn)
    for await (const _chunk of runtime.streamPrompt('x', 'sess-A')) { /* drain */ }
    expect(piAgent.sessionId).toBe('sess-A')

    runtimeHarness.promptBehaviors.push(endTurn)
    for await (const _chunk of runtime.streamPrompt('y', 'sess-B')) { /* drain */ }
    expect(piAgent.sessionId).toBe('sess-B')

    piAgent.state.messages = [
      { role: 'system', content: 'prompt', timestamp: 0 },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [], stopReason: 'error', errorMessage: '429' },
    ] as never
    runtimeHarness.promptBehaviors.push(endTurn)
    for await (const _chunk of runtime.retryLastTurn('hello', 'sess-C')) { /* drain */ }

    expect(runtimeHarness.promptSessionIds).toEqual(['sess-A', 'sess-B', 'sess-C'])
  })

  describe('image generation models', () => {
    const configDir = '/tmp/axiom-agent-runtime-test-config'
    const providersPath = path.join(configDir, 'providers.json')

    function writeProviders(enabledImageModels: string[]): void {
      fs.mkdirSync(configDir, { recursive: true })
      fs.writeFileSync(providersPath, JSON.stringify({
        providers: [{
          id: 'or-1',
          name: 'OpenRouter',
          type: 'openai-completions',
          providerType: 'openrouter',
          provider: 'openrouter',
          baseUrl: 'https://openrouter.ai/api/v1',
          apiKey: 'test-key',
          authMethod: 'api-key',
          enabledModels: ['qwen/qwen3.8-flash'],
          enabledImageModels,
          models: [
            { id: 'qwen/qwen3.8-flash', description: 'Cheap coding model.' },
            { id: 'recraft/recraft-v4.1-vector', description: 'SVG logos.' },
          ],
        }],
      }))
    }

    function latestPromptOptions() {
      return vi.mocked(assembleSystemPromptWithSections).mock.calls.at(-1)?.[0]
    }

    function latestActiveTools(): ReadonlySet<string> | undefined {
      return vi.mocked(getAgentSkillsForPrompt).mock.calls.at(-1)?.[0]?.activeTools
    }

    function imageToolOf(runtime: ReturnType<typeof createAgentRuntime>): AgentTool | undefined {
      return (runtime as unknown as AgentRuntimePiAgentAccess).getAgent().state.tools.find(tool => tool.name === 'image_generate')
    }

    const defaultLoadConfig = vi.mocked(loadConfig).getMockImplementation()!

    function setImageGenerationSettings(imageGeneration: Record<string, unknown>): void {
      vi.mocked(loadConfig).mockImplementation(((filename: string) => ({
        ...(defaultLoadConfig(filename) as object),
        imageGeneration,
      })) as typeof loadConfig)
    }

    afterEach(() => {
      vi.mocked(loadConfig).mockImplementation(defaultLoadConfig)
    })

    it('drops the tool, the image model block and the skill while image generation is switched off', async () => {
      writeProviders(['recraft/recraft-v4.1-vector'])
      try {
        setImageGenerationSettings({ enabled: false })
        const runtime = createAgentRuntime({ model: makeModel(), apiKey: 'sk-primary', db: initDatabase(':memory:'), tools: [] })
        await runTurn(runtime)

        expect(runtime.getStateSnapshot().toolNames).not.toContain('image_generate')
        expect(latestPromptOptions()?.availableImageModels).toEqual([])
        expect(latestActiveTools()?.has('image_generate')).toBe(false)

        setImageGenerationSettings({ enabled: true })
        await startNewSession(runtime)
        expect(runtime.getStateSnapshot().toolNames).toContain('image_generate')
        expect(latestPromptOptions()?.availableImageModels).toHaveLength(1)
        expect(latestActiveTools()?.has('image_generate')).toBe(true)

        setImageGenerationSettings({ enabled: false })
        await startNewSession(runtime)
        expect(runtime.getStateSnapshot().toolNames).not.toContain('image_generate')
        expect(latestPromptOptions()?.availableImageModels).toEqual([])
      } finally {
        fs.rmSync(configDir, { recursive: true, force: true })
      }
    })

    it('offers nothing when image generation is on but no image model is enabled', async () => {
      writeProviders([])
      try {
        setImageGenerationSettings({ enabled: true })
        const runtime = createAgentRuntime({ model: makeModel(), apiKey: 'sk-primary', db: initDatabase(':memory:'), tools: [] })
        await runTurn(runtime)

        expect(runtime.getStateSnapshot().toolNames).not.toContain('image_generate')
        expect(latestPromptOptions()?.availableImageModels).toEqual([])
        expect(latestActiveTools()?.has('image_generate')).toBe(false)
      } finally {
        fs.rmSync(configDir, { recursive: true, force: true })
      }
    })

    it('picks up a changed image_generate declaration only in the next session', async () => {
      writeProviders(['recraft/recraft-v4.1-vector'])
      const maxVariants = (tool: AgentTool | undefined) => (tool?.parameters as unknown as { properties: { n: { maximum: number } } }).properties.n.maximum
      try {
        setImageGenerationSettings({ maxVariants: 2 })
        const runtime = createAgentRuntime({ model: makeModel(), apiKey: 'sk-primary', db: initDatabase(':memory:'), tools: [] })
        await runTurn(runtime)
        const first = imageToolOf(runtime)
        expect(maxVariants(first)).toBe(2)

        setImageGenerationSettings({ maxVariants: 6 })
        await runTurn(runtime)
        expect(imageToolOf(runtime)).toBe(first)

        await startNewSession(runtime)
        expect(maxVariants(imageToolOf(runtime))).toBe(6)
      } finally {
        fs.rmSync(configDir, { recursive: true, force: true })
      }
    })

    it('keeps image models out of the text model list and passes them as image models', async () => {
      writeProviders(['recraft/recraft-v4.1-vector'])
      try {
        const runtime = createAgentRuntime({ model: makeModel(), apiKey: 'sk-primary', db: initDatabase(':memory:'), tools: [] })
        await runTurn(runtime)

        const options = latestPromptOptions()
        const textModelIds = options?.availableProviders?.flatMap(p => p.models.map(m => m.id))
        expect(textModelIds).toEqual(['qwen/qwen3.8-flash'])
        expect(options?.availableImageModels).toEqual([
          { provider: 'OpenRouter', id: 'recraft/recraft-v4.1-vector', description: 'SVG logos.', isDefault: true },
        ])
        expect(runtime.getStateSnapshot().toolNames).toContain('image_generate')
      } finally {
        fs.rmSync(configDir, { recursive: true, force: true })
      }
    })

    it('adds and removes image_generate with the next session as image models are enabled or removed', async () => {
      writeProviders([])
      try {
        const runtime = createAgentRuntime({ model: makeModel(), apiKey: 'sk-primary', db: initDatabase(':memory:'), tools: [] })
        await runTurn(runtime)
        expect(runtime.getStateSnapshot().toolNames).not.toContain('image_generate')
        expect(latestPromptOptions()?.availableImageModels).toEqual([])

        writeProviders(['recraft/recraft-v4.1-vector'])
        await runTurn(runtime)
        expect(runtime.getStateSnapshot().toolNames).not.toContain('image_generate')

        await startNewSession(runtime)
        expect(runtime.getStateSnapshot().toolNames.filter(name => name === 'image_generate')).toHaveLength(1)

        await startNewSession(runtime)
        expect(runtime.getStateSnapshot().toolNames.filter(name => name === 'image_generate')).toHaveLength(1)

        writeProviders([])
        await startNewSession(runtime)
        expect(runtime.getStateSnapshot().toolNames).not.toContain('image_generate')
      } finally {
        fs.rmSync(configDir, { recursive: true, force: true })
      }
    })
  })

  describe('codemode main agent', () => {
    const defaultLoadConfig = vi.mocked(loadConfig).getMockImplementation()!
    const codemode = { mainAgent: false }

    beforeEach(() => {
      // Installed per test: earlier describes restore the default loadConfig
      // mock in their afterEach, which would otherwise drop the codemode key.
      codemode.mainAgent = false
      vi.mocked(loadConfig).mockImplementation(((filename: string) => ({
        ...(defaultLoadConfig(filename) as object),
        codemode: { ...codemode },
      })) as typeof loadConfig)
    })

    afterEach(() => {
      codemode.mainAgent = false
      vi.mocked(loadConfig).mockImplementation(defaultLoadConfig)
    })

    function codemodeToolOf(runtime: ReturnType<typeof createAgentRuntime>): AgentTool | undefined {
      return (runtime as unknown as AgentRuntimePiAgentAccess).getAgent().state.tools.find(tool => tool.name === 'codemode')
    }

    function leadingSystemMessage(runtime: ReturnType<typeof createAgentRuntime>): string {
      const message = (runtime as unknown as AgentRuntimePiAgentAccess).getAgent().state.messages[0] as { content?: string } | undefined
      return message?.content ?? ''
    }

    it('adds the codemode tool, with its guideline in the description, from the next session after the setting turns on', async () => {
      const db = initDatabase(':memory:')
      const interactiveTool = { name: 'interactive-only-tool', description: 'Only usable in chat.', parameters: {}, execute: vi.fn() } as unknown as AgentTool
      const runtime = createAgentRuntime({ model: makeModel(), apiKey: 'sk-primary', db, tools: [interactiveTool] })

      await runTurn(runtime)
      expect(codemodeToolOf(runtime)).toBeUndefined()
      expect(leadingSystemMessage(runtime)).toBe('runtime system prompt')

      codemode.mainAgent = true
      await runTurn(runtime)
      expect(codemodeToolOf(runtime)).toBeUndefined()

      await startNewSession(runtime)
      const codemodeTool = codemodeToolOf(runtime)
      expect(codemodeTool).toBeDefined()
      expect(runtime.getStateSnapshot().toolNames).toContain('codemode')
      // The tool description is rendered from the main agent's own tools.
      expect(codemodeTool!.description).toContain('`tools.interactive_only_tool` is the tool `interactive-only-tool`.')
      expect(codemodeTool!.description).toContain('Do NOT wrap a single tool call in a script')
      expect(leadingSystemMessage(runtime)).toBe('runtime system prompt')
    })

    it('keeps codemode for the running session and drops it in the next one when the setting turns off', async () => {
      const db = initDatabase(':memory:')
      const runtime = createAgentRuntime({ model: makeModel(), apiKey: 'sk-primary', db, tools: [] })

      codemode.mainAgent = true
      await runTurn(runtime)
      const first = codemodeToolOf(runtime)
      expect(first).toBeDefined()

      codemode.mainAgent = false
      await runTurn(runtime)
      expect(codemodeToolOf(runtime)).toBe(first)

      await startNewSession(runtime)
      expect(codemodeToolOf(runtime)).toBeUndefined()
      expect(leadingSystemMessage(runtime)).toBe('runtime system prompt')
    })

    it('breaks the context down by the snapshot sections, without a codemode block', async () => {
      const runtime = createAgentRuntime({ model: makeModel(), apiKey: 'sk-primary', db: initDatabase(':memory:'), tools: [] })
      codemode.mainAgent = true
      vi.mocked(assembleSystemPromptWithSections).mockReturnValueOnce({
        prompt: 'runtime system prompt',
        sections: [{ key: 'personality', text: 'runtime system prompt' }],
      })
      await runTurn(runtime)

      const sectionKeys = () => runtime.getContextUsage()?.breakdown?.systemPrompt.sections.map(section => section.key).sort()
      expect(sectionKeys()).toEqual(['personality'])

      const piAgent = (runtime as unknown as AgentRuntimePiAgentAccess).getAgent()
      piAgent.state.messages = [{ ...piAgent.state.messages[0], content: 'replaced elsewhere' } as never]
      expect(sectionKeys()).toEqual(['other'])
    })

    it('runs nested calls through the main agent\'s tools, including interactive-only ones', async () => {
      const db = initDatabase(':memory:')
      const interactiveTool = { name: 'interactive_only_tool', description: 'Only usable in chat.', parameters: {}, execute: vi.fn() } as unknown as AgentTool
      const runtime = createAgentRuntime({ model: makeModel(), apiKey: 'sk-primary', db, tools: [interactiveTool] })

      codemode.mainAgent = true
      await runTurn(runtime)
      const codemodeTool = codemodeToolOf(runtime)!
      const piAgent = (runtime as unknown as AgentRuntimePiAgentAccess).getAgent()
      piAgent.sessionId = 'session-1'

      const result = await (codemodeTool as { execute: (id: string, params: { code: string }, signal?: AbortSignal) => Promise<{ content: { type: string; text: string }[] }> }).execute(
        'code-1',
        { code: 'return await tools.interactive_only_tool({ x: 1 })' },
        new AbortController().signal,
      )

      expect(runtimeHarness.runToolCallCalls).toHaveLength(1)
      const { toolCall, options } = runtimeHarness.runToolCallCalls[0]!
      expect((toolCall as { name: string }).name).toBe('interactive_only_tool')
      expect((toolCall as { arguments: { x: number } }).arguments).toEqual({ x: 1 })
      // The dispatch sees the main agent\'s live tool set (minus codemode).
      const dispatchedTools = (options as { tools: { name: string }[] }).tools.map(t => t.name)
      expect(dispatchedTools).toContain('interactive_only_tool')
      expect(dispatchedTools).not.toContain('codemode')
      expect(result.content.map(block => block.text).join('')).toContain('nested-tool-ok')
    })

    it('maps codemode partial updates to tool_call_update chunks with the parent id and snapshot', async () => {
      const db = initDatabase(':memory:')
      const runtime = createAgentRuntime({ model: makeModel(), apiKey: 'sk-primary', db, tools: [] })
      const piAgent = (runtime as unknown as AgentRuntimePiAgentAccess).getAgent() as unknown as { emit: (event: unknown) => void }

      runtimeHarness.promptBehaviors.push(async () => {
        piAgent.emit({ type: 'tool_execution_start', toolName: 'codemode', toolCallId: 'code-1', args: { code: 'x' } })
        piAgent.emit({
          type: 'tool_execution_update',
          toolName: 'codemode',
          toolCallId: 'code-1',
          args: { code: 'x' },
          partialResult: { content: [], details: { calls: [{ id: 'code-1/file_read/1', name: 'file_read', status: 'running' }] } },
        })
        // Updates of other tools never produce a chat chunk.
        piAgent.emit({ type: 'tool_execution_update', toolName: 'shell', toolCallId: 'sh-1', args: {}, partialResult: { content: [] } })
        piAgent.emit({ type: 'agent_end', messages: [] })
      })

      const chunks = [] as Array<{ type: string; toolCallId?: string; nestedCalls?: unknown[] }>
      for await (const chunk of runtime.streamPrompt('run it', 'session-1')) {
        chunks.push(chunk)
      }

      const updates = chunks.filter(c => c.type === 'tool_call_update')
      expect(updates).toHaveLength(1)
      expect(updates[0]).toMatchObject({
        toolName: 'codemode',
        toolCallId: 'code-1',
        nestedCalls: [{ id: 'code-1/file_read/1', name: 'file_read', status: 'running' }],
      })
      expect(chunks.map(c => c.type)).toEqual(['tool_call_start', 'tool_call_update', 'done'])
    })
  })
})
