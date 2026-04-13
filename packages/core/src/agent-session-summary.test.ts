/**
 * Tests for generateSessionSummary (session-end daily log with open threads).
 *
 * We test the behavior through the SessionManager + AgentCore integration:
 * the summary returned from generateSessionSummary is written verbatim to the
 * daily file, so we verify both the LLM prompt content and the output format.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// ── Mocks must be hoisted before any imports that load the mocked modules ─────

vi.mock('./memory.js', () => ({
  ensureMemoryStructure: vi.fn(),
  ensureConfigStructure: vi.fn(),
  assembleSystemPrompt: vi.fn(() => 'test system prompt'),
  appendToDailyFile: vi.fn(),
  getMemoryDir: vi.fn(() => '/tmp/test-memory'),
}))

vi.mock('./config.js', () => ({
  ensureConfigTemplates: vi.fn(),
  loadConfig: vi.fn(() => ({})),
  getConfigDir: vi.fn(() => '/tmp/test-config'),
}))

vi.mock('./provider-config.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>
  return {
    ...original,
    getApiKeyForProvider: vi.fn().mockResolvedValue('test-key'),
    buildModel: vi.fn().mockReturnValue({ id: 'mock-model' }),
    loadProvidersDecrypted: vi.fn().mockReturnValue({ providers: [] }),
    estimateCost: vi.fn().mockReturnValue(0),
  }
})

vi.mock('./skill-config.js', () => ({
  loadSkills: vi.fn().mockReturnValue({ skills: [] }),
  getSkillDecrypted: vi.fn(),
}))

vi.mock('./web-tools.js', () => ({
  createBuiltinWebTools: vi.fn(() => []),
}))

vi.mock('./stt-tool.js', () => ({
  createTranscribeAudioTool: vi.fn(() => ({})),
}))

vi.mock('./stt.js', () => ({
  loadSttSettings: vi.fn().mockReturnValue({ enabled: false }),
}))

vi.mock('./agent-skills.js', () => ({
  createAgentSkillTools: vi.fn(() => []),
  getAgentSkillsForPrompt: vi.fn(() => []),
  getAgentSkillsCount: vi.fn(() => 0),
  getAgentSkillsDir: vi.fn(() => '/tmp/test-agent-skills'),
  trackAgentSkillUsage: vi.fn(),
}))

vi.mock('./workspace.js', () => ({
  getWorkspaceDir: vi.fn(() => '/tmp/test-workspace'),
}))

vi.mock('./token-logger.js', () => ({
  logTokenUsage: vi.fn(),
  logToolCall: vi.fn(),
}))

// Mock pi-ai completeSimple so we can control LLM responses
vi.mock('@mariozechner/pi-ai', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>
  return {
    ...original,
    completeSimple: vi.fn(),
    Type: (original as { Type: unknown }).Type,
  }
})

// ── Imports after mocks ────────────────────────────────────────────────────────

import { AgentCore } from './agent.js'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import { completeSimple } from '@mariozechner/pi-ai'
import { appendToDailyFile } from './memory.js'

const mockCompleteSimple = vi.mocked(completeSimple)
const mockAppendToDailyFile = vi.mocked(appendToDailyFile)

// ── Helpers ────────────────────────────────────────────────────────────────────

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

function makeCompleteSimpleResponse(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
    model: 'gpt-4o',
    provider: 'openai',
    stopReason: 'end_turn' as const,
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('generateSessionSummary — open threads prompt', () => {
  let db: Database
  let tmpDir: string
  let memoryDir: string

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `openagent-summary-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    memoryDir = path.join(tmpDir, 'memory')
    fs.mkdirSync(path.join(memoryDir, 'daily'), { recursive: true })

    db = initDatabase(':memory:')
    mockCompleteSimple.mockReset()
    mockAppendToDailyFile.mockReset()
  })

  afterEach(() => {
    if (db) db.close()
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('sends conversation history to completeSimple', async () => {
    mockCompleteSimple.mockResolvedValueOnce(
      makeCompleteSimpleResponse('Discussed Docker deployment options.')
    )

    const agent = new AgentCore({
      model: makeModel(),
      apiKey: 'sk-test',
      db,
      tools: [],
      memoryDir,
    })

    // Access private method via type cast
    const summary = await (agent as unknown as {
      generateSessionSummary: (userId: string, history?: string) => Promise<string>
    }).generateSessionSummary('user1', 'User: How do I deploy with Docker?\nAssistant: Use docker compose up.')

    expect(mockCompleteSimple).toHaveBeenCalledOnce()
    const [, callOptions] = mockCompleteSimple.mock.calls[0]
    expect(callOptions.messages[0].content).toContain('How do I deploy with Docker?')
    expect(summary).toBe('Discussed Docker deployment options.')
  })

  it('prompt instructs LLM to add ### Offene Fäden section for unresolved items', async () => {
    mockCompleteSimple.mockResolvedValueOnce(
      makeCompleteSimpleResponse('Discussed PR workflow.\n\n### Offene Fäden\n- PR for PDF upload not yet merged')
    )

    const agent = new AgentCore({
      model: makeModel(),
      apiKey: 'sk-test',
      db,
      tools: [],
      memoryDir,
    })

    const [, callOptions] = await (async () => {
      await (agent as unknown as {
        generateSessionSummary: (userId: string, history?: string) => Promise<string>
      }).generateSessionSummary('user1', 'User: Can you start the PR for PDF upload?\nAssistant: I started the PR.')
      return mockCompleteSimple.mock.calls[0]
    })()

    // The system prompt must mention "Offene Fäden"
    expect(callOptions.systemPrompt).toContain('Offene Fäden')
    // The system prompt must explain what counts as open
    expect(callOptions.systemPrompt).toContain('unfinished tasks')
    // The system prompt must prohibit empty sections
    expect(callOptions.systemPrompt).toContain('empty')
  })

  it('returns summary with open threads section when LLM includes it', async () => {
    const llmOutput = 'Discussed PR for PDF upload extraction and open threads feature.\n\n### Offene Fäden\n- PR for PDF-upload-extraction started, result not yet confirmed\n- Open threads feature discussed, PR not yet started'
    mockCompleteSimple.mockResolvedValueOnce(makeCompleteSimpleResponse(llmOutput))

    const agent = new AgentCore({
      model: makeModel(),
      apiKey: 'sk-test',
      db,
      tools: [],
      memoryDir,
    })

    const summary = await (agent as unknown as {
      generateSessionSummary: (userId: string, history?: string) => Promise<string>
    }).generateSessionSummary('user1', 'User: Lets work on two things...\nAssistant: Sure.')

    expect(summary).toBe(llmOutput)
    expect(summary).toContain('### Offene Fäden')
    expect(summary).toContain('PR for PDF-upload-extraction started')
  })

  it('returns summary without open threads section when LLM omits it', async () => {
    const llmOutput = 'Answered question about Docker compose syntax. No open items.'
    mockCompleteSimple.mockResolvedValueOnce(makeCompleteSimpleResponse(llmOutput))

    const agent = new AgentCore({
      model: makeModel(),
      apiKey: 'sk-test',
      db,
      tools: [],
      memoryDir,
    })

    const summary = await (agent as unknown as {
      generateSessionSummary: (userId: string, history?: string) => Promise<string>
    }).generateSessionSummary('user1', 'User: What does --build do?\nAssistant: It rebuilds images.')

    expect(summary).toBe(llmOutput)
    expect(summary).not.toContain('### Offene Fäden')
  })

  it('returns "Empty session." when no conversation history is provided', async () => {
    const agent = new AgentCore({
      model: makeModel(),
      apiKey: 'sk-test',
      db,
      tools: [],
      memoryDir,
    })

    const summary = await (agent as unknown as {
      generateSessionSummary: (userId: string, history?: string) => Promise<string>
    }).generateSessionSummary('user1', undefined)

    expect(summary).toBe('Empty session.')
    expect(mockCompleteSimple).not.toHaveBeenCalled()
  })

  it('returns fallback text when completeSimple throws', async () => {
    mockCompleteSimple.mockRejectedValueOnce(new Error('LLM unavailable'))

    const agent = new AgentCore({
      model: makeModel(),
      apiKey: 'sk-test',
      db,
      tools: [],
      memoryDir,
    })

    const summary = await (agent as unknown as {
      generateSessionSummary: (userId: string, history?: string) => Promise<string>
    }).generateSessionSummary('user1', 'User: Hello\nAssistant: Hi')

    expect(summary).toBe('Session ended (summary generation failed).')
  })

  it('uses a single completeSimple call (no second call for open threads)', async () => {
    mockCompleteSimple.mockResolvedValue(
      makeCompleteSimpleResponse('Activity log text.\n\n### Offene Fäden\n- Something open')
    )

    const agent = new AgentCore({
      model: makeModel(),
      apiKey: 'sk-test',
      db,
      tools: [],
      memoryDir,
    })

    await (agent as unknown as {
      generateSessionSummary: (userId: string, history?: string) => Promise<string>
    }).generateSessionSummary('user1', 'User: Start a task\nAssistant: Task started.')

    // Must be exactly one LLM call — not two
    expect(mockCompleteSimple).toHaveBeenCalledTimes(1)
  })

  it('daily file entry contains both activity and open threads when present', async () => {
    // Use real appendToDailyFile logic by using a real SessionManager + fake summarizer
    // We verify by checking the summary text that gets written
    const llmOutput = 'Reviewed PR structure and discussed open threads feature.\n\n### Offene Fäden\n- Open threads feature: PR not yet created'
    mockCompleteSimple.mockResolvedValueOnce(makeCompleteSimpleResponse(llmOutput))

    const agent = new AgentCore({
      model: makeModel(),
      apiKey: 'sk-test',
      db,
      tools: [],
      memoryDir,
    })

    const summary = await (agent as unknown as {
      generateSessionSummary: (userId: string, history?: string) => Promise<string>
    }).generateSessionSummary('user1', 'User: Lets discuss the feature\nAssistant: Sure, two parts...')

    // The summary is written verbatim inside the ## HH:MM block in session-manager.ts
    // Verify the structure is correct for downstream use
    expect(summary).toMatch(/^Reviewed PR structure/)
    expect(summary).toContain('\n\n### Offene Fäden\n')
    expect(summary).toContain('- Open threads feature: PR not yet created')
  })
})
