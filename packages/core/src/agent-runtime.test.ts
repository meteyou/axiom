import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createAgentRuntime } from './agent-runtime.js'
import { initDatabase } from './database.js'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import { assembleSystemPrompt } from './memory.js'
import { logToolCall } from './token-logger.js'

const runtimeHarness = vi.hoisted(() => ({
  promptBehaviors: [] as Array<(agent: { emit: (event: unknown) => void }, text: string) => Promise<void>>,
}))

vi.mock('@mariozechner/pi-agent-core', () => {
  class MockAgent {
    public state: { systemPrompt: string; model: unknown; tools: AgentTool[]; messages: unknown[] }
    private listeners = new Set<(event: unknown) => void>()

    constructor(options: { initialState: { systemPrompt: string; model: unknown; tools: AgentTool[] } }) {
      this.state = {
        ...options.initialState,
        messages: [],
      }
    }

    subscribe(listener: (event: unknown) => void): () => void {
      this.listeners.add(listener)
      return () => this.listeners.delete(listener)
    }

    async prompt(text: string): Promise<void> {
      const behavior = runtimeHarness.promptBehaviors.shift()
      if (behavior) {
        await behavior(this, text)
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
    buildModel: vi.fn((provider: { defaultModel: string }) => ({ id: provider.defaultModel })),
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
})
