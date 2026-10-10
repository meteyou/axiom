import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createAgentRuntime } from './agent-runtime.js'
import type { AgentRuntimePiAgentAccess } from './agent-runtime.js'
import { initDatabase } from './database.js'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { assembleSystemPrompt } from './memory.js'
import { logToolCall } from './token-logger.js'
import { loadConfig } from './config.js'
import { getAgentSkillsForPrompt } from './agent-skills.js'

const runtimeHarness = vi.hoisted(() => ({
  promptBehaviors: [] as Array<(agent: { emit: (event: unknown) => void }, text: string) => Promise<void>>,
  promptCalls: [] as string[],
  promptSessionIds: [] as Array<string | undefined>,
  continueCalls: 0,
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

  return { Agent: MockAgent }
})

vi.mock('./memory.js', () => ({
  ensureMemoryStructure: vi.fn(),
  ensureConfigStructure: vi.fn(),
  getMemoryDir: vi.fn(() => '/tmp/test-memory'),
  assembleSystemPrompt: vi.fn(() => 'runtime system prompt'),
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
  createTranscribeAudioTool: vi.fn(() => ({ name: 'transcribe_audio', execute: vi.fn() })),
}))

vi.mock('./web-tools.js', () => ({
  createBuiltinWebTools: vi.fn(() => [{ name: 'builtin_web_tool', execute: vi.fn() }]),
}))

vi.mock('./agent-skills.js', () => ({
  createAgentSkillTools: vi.fn(() => [{ name: 'agent_skill_tool', execute: vi.fn() }]),
  getAgentSkillsForPrompt: vi.fn(() => [{ name: 'recent skill', description: 'desc', location: '/skills-agent/recent' }]),
  getAgentSkillsCount: vi.fn(() => 1),
  getAgentSkillsDir: vi.fn(() => '/skills-agent'),
  trackAgentSkillUsage: vi.fn(),
  currentPlatform: vi.fn(() => 'linux'),
}))

vi.mock('./memories-tool.js', () => ({
  createSearchMemoriesTool: vi.fn(() => ({ name: 'search_memories', execute: vi.fn() })),
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
    vi.mocked(assembleSystemPrompt).mockClear()
    vi.mocked(logToolCall).mockClear()
  })

  it('wires tools behind a single runtime boundary', () => {
    const db = initDatabase(':memory:')
    const customTool = { name: 'custom_tool', execute: vi.fn() } as unknown as AgentTool

    const runtime = createAgentRuntime({
      model: makeModel(),
      apiKey: 'sk-primary',
      db,
      tools: [customTool],
    })

    const toolNames = runtime.getStateSnapshot().toolNames
    expect(toolNames).toEqual(expect.arrayContaining([
      'custom_tool',
      'search_memories',
      'builtin_web_tool',
      'transcribe_audio',
      'agent_skill_tool',
      'shell',
      'read_file',
      'write_file',
      'edit_file',
      'list_files',
    ]))
  })

  it('assembles system prompt via runtime boundary with config + skills context', () => {
    const db = initDatabase(':memory:')
    const runtime = createAgentRuntime({
      model: makeModel(),
      apiKey: 'sk-primary',
      db,
      tools: [],
      memoryDir: '/tmp/memory',
      baseInstructions: 'base rules',
    })

    runtime.refreshSystemPrompt('telegram', { username: 'alice' })

    const promptCalls = vi.mocked(assembleSystemPrompt).mock.calls
    const latestCall = promptCalls.at(-1)?.[0]
    expect(latestCall).toBeDefined()
    expect(latestCall?.language).toBe('de')
    expect(latestCall?.timezone).toBe('Europe/Berlin')
    expect(latestCall?.channel).toBe('telegram')
    expect(latestCall?.currentUser).toEqual({ username: 'alice' })
    expect(latestCall?.builtinTools).toEqual({ webSearch: { enabled: true }, stt: { enabled: true } })
    expect(latestCall?.skills).toEqual(expect.arrayContaining([
      { name: 'Enabled skill', description: 'desc', location: '/skills/enabled' },
      { name: 'recent skill', description: 'desc', location: '/skills-agent/recent' },
    ]))
  })

  it('replaces the leading system message on refresh and keeps it when clearing messages', () => {
    const db = initDatabase(':memory:')
    const runtime = createAgentRuntime({
      model: makeModel(),
      apiKey: 'sk-primary',
      db,
      tools: [],
    })
    const piAgent = (runtime as unknown as AgentRuntimePiAgentAccess).getAgent()
    piAgent.state.messages = [
      { role: 'system', content: 'old prompt', timestamp: 0 },
      { role: 'user', content: 'hello', timestamp: 1 },
    ] as never

    vi.mocked(assembleSystemPrompt).mockReturnValueOnce('new prompt')
    runtime.refreshSystemPrompt()

    expect(piAgent.state.messages).toEqual([
      { role: 'system', content: 'new prompt', timestamp: 0 },
      { role: 'user', content: 'hello', timestamp: 1 },
    ])

    runtime.clearMessages()

    expect(piAgent.state.messages).toEqual([{ role: 'system', content: 'new prompt', timestamp: 0 }])
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
        toolName: 'search_memories',
        toolCallId: 'tool-1',
        args: { query: 'test' },
      })
      agent.emit({
        type: 'tool_execution_end',
        toolName: 'search_memories',
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
      agent.emit({ type: 'tool_execution_start', toolName: 'read_file', toolCallId: 'tool-err', args: { path: 'missing.txt' } })
      agent.emit({
        type: 'tool_execution_end',
        toolName: 'read_file',
        toolCallId: 'tool-err',
        isError: false,
        result: { content: [{ type: 'text', text: 'File not found' }], details: { error: true } },
      })
      agent.emit({ type: 'tool_execution_start', toolName: 'read_file', toolCallId: 'tool-ok', args: { path: 'a.txt' } })
      agent.emit({
        type: 'tool_execution_end',
        toolName: 'read_file',
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
      agent.emit({ type: 'tool_execution_start', toolName: 'read_file', toolCallId: 'tool-img', args: { path: 'a.png' } })
      agent.emit({
        type: 'tool_execution_end',
        toolName: 'read_file',
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
    const endTurn = async (agent: { emit: (event: unknown) => void }) => {
      agent.emit({ type: 'agent_end', messages: [] })
    }

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
      return vi.mocked(assembleSystemPrompt).mock.calls.at(-1)?.[0]
    }

    function latestActiveTools(): Set<string> | undefined {
      return vi.mocked(getAgentSkillsForPrompt).mock.calls.at(-1)?.[0]?.activeTools
    }

    function imageToolOf(runtime: ReturnType<typeof createAgentRuntime>): AgentTool | undefined {
      return (runtime as unknown as AgentRuntimePiAgentAccess).getAgent().state.tools.find(tool => tool.name === 'generate_image')
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

    it('drops the tool, the image model block and the skill while image generation is switched off', () => {
      writeProviders(['recraft/recraft-v4.1-vector'])
      try {
        setImageGenerationSettings({ enabled: false })
        const runtime = createAgentRuntime({ model: makeModel(), apiKey: 'sk-primary', db: initDatabase(':memory:'), tools: [] })
        runtime.refreshSystemPrompt()

        expect(runtime.getStateSnapshot().toolNames).not.toContain('generate_image')
        expect(latestPromptOptions()?.availableImageModels).toEqual([])
        expect(latestActiveTools()?.has('generate_image')).toBe(false)

        setImageGenerationSettings({ enabled: true })
        runtime.refreshSystemPrompt()
        expect(runtime.getStateSnapshot().toolNames).toContain('generate_image')
        expect(latestPromptOptions()?.availableImageModels).toHaveLength(1)
        expect(latestActiveTools()?.has('generate_image')).toBe(true)

        setImageGenerationSettings({ enabled: false })
        runtime.refreshSystemPrompt()
        expect(runtime.getStateSnapshot().toolNames).not.toContain('generate_image')
        expect(latestPromptOptions()?.availableImageModels).toEqual([])
      } finally {
        fs.rmSync(configDir, { recursive: true, force: true })
      }
    })

    it('offers nothing when image generation is on but no image model is enabled', () => {
      writeProviders([])
      try {
        setImageGenerationSettings({ enabled: true })
        const runtime = createAgentRuntime({ model: makeModel(), apiKey: 'sk-primary', db: initDatabase(':memory:'), tools: [] })
        runtime.refreshSystemPrompt()

        expect(runtime.getStateSnapshot().toolNames).not.toContain('generate_image')
        expect(latestPromptOptions()?.availableImageModels).toEqual([])
        expect(latestActiveTools()?.has('generate_image')).toBe(false)
      } finally {
        fs.rmSync(configDir, { recursive: true, force: true })
      }
    })

    it('redeclares generate_image only when its declaration changes', () => {
      writeProviders(['recraft/recraft-v4.1-vector'])
      try {
        setImageGenerationSettings({ maxVariants: 2 })
        const runtime = createAgentRuntime({ model: makeModel(), apiKey: 'sk-primary', db: initDatabase(':memory:'), tools: [] })
        runtime.refreshSystemPrompt()
        const first = imageToolOf(runtime)
        expect((first?.parameters as unknown as { properties: { n: { maximum: number } } }).properties.n.maximum).toBe(2)

        runtime.refreshSystemPrompt()
        expect(imageToolOf(runtime)).toBe(first)

        setImageGenerationSettings({ maxVariants: 6 })
        runtime.refreshSystemPrompt()
        const redeclared = imageToolOf(runtime)
        expect(redeclared).not.toBe(first)
        expect((redeclared?.parameters as unknown as { properties: { n: { maximum: number } } }).properties.n.maximum).toBe(6)
      } finally {
        fs.rmSync(configDir, { recursive: true, force: true })
      }
    })

    it('keeps image models out of the text model list and passes them as image models', () => {
      writeProviders(['recraft/recraft-v4.1-vector'])
      try {
        const runtime = createAgentRuntime({ model: makeModel(), apiKey: 'sk-primary', db: initDatabase(':memory:'), tools: [] })
        runtime.refreshSystemPrompt()

        const options = latestPromptOptions()
        const textModelIds = options?.availableProviders?.flatMap(p => p.models.map(m => m.id))
        expect(textModelIds).toEqual(['qwen/qwen3.8-flash'])
        expect(options?.availableImageModels).toEqual([
          { provider: 'OpenRouter', id: 'recraft/recraft-v4.1-vector', description: 'SVG logos.', isDefault: true },
        ])
        expect(runtime.getStateSnapshot().toolNames).toContain('generate_image')
      } finally {
        fs.rmSync(configDir, { recursive: true, force: true })
      }
    })

    it('adds and removes generate_image as image models are enabled or removed', () => {
      writeProviders([])
      try {
        const runtime = createAgentRuntime({ model: makeModel(), apiKey: 'sk-primary', db: initDatabase(':memory:'), tools: [] })
        expect(runtime.getStateSnapshot().toolNames).not.toContain('generate_image')
        expect(latestPromptOptions()?.availableImageModels).toEqual([])

        writeProviders(['recraft/recraft-v4.1-vector'])
        runtime.refreshSystemPrompt()
        expect(runtime.getStateSnapshot().toolNames.filter(name => name === 'generate_image')).toHaveLength(1)

        runtime.refreshSystemPrompt()
        expect(runtime.getStateSnapshot().toolNames.filter(name => name === 'generate_image')).toHaveLength(1)

        writeProviders([])
        runtime.refreshSystemPrompt()
        expect(runtime.getStateSnapshot().toolNames).not.toContain('generate_image')
      } finally {
        fs.rmSync(configDir, { recursive: true, force: true })
      }
    })
  })
})
