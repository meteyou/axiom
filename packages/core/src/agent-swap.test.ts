import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AgentCore } from './agent.js'
import { ProviderManager } from './provider-manager.js'
import type { ProviderConfig } from './provider-config.js'
import { initDatabase } from './database.js'
import type { Database } from './database.js'

// Mock the memory, config, and provider-config modules to avoid filesystem access
vi.mock('./memory.js', () => ({
  ensureMemoryStructure: vi.fn(),
  assembleSystemPrompt: vi.fn(() => 'test system prompt'),
}))

vi.mock('./config.js', () => ({
  ensureConfigTemplates: vi.fn(),
  loadConfig: vi.fn(() => ({})),
  getConfigDir: vi.fn(() => '/tmp/test-config'),
}))

vi.mock('./memory-tools.js', () => ({
  createMemoryTools: vi.fn(() => []),
}))

function makeProvider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'test-primary',
    name: 'Primary',
    type: 'openai-completions',
    providerType: 'openai',
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-primary',
    defaultModel: 'gpt-4o',
    ...overrides,
  }
}

function makeFallbackProvider(): ProviderConfig {
  return makeProvider({
    id: 'test-fallback',
    name: 'Fallback',
    providerType: 'anthropic',
    type: 'anthropic-messages',
    provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'sk-fallback',
    defaultModel: 'claude-sonnet-4-20250514',
  })
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

describe('AgentCore.swapProvider', () => {
  let db: Database

  beforeEach(() => {
    db = initDatabase(':memory:')
  })

  it('swapProvider() exists and updates model, apiKey, providerConfig', () => {
    const primary = makeProvider()
    const agentCore = new AgentCore({
      model: makeModel(),
      apiKey: 'sk-primary',
      db,
      yoloMode: false,
      tools: [],
      providerConfig: primary,
    })

    const fallback = makeFallbackProvider()
    agentCore.swapProvider(fallback, 'sk-fallback')

    // Verify the agent is still functional (no crash)
    const piAgent = agentCore.getAgent()
    expect(piAgent).toBeDefined()
    // The model should have been updated via setModel
    expect(piAgent.state.model.id).toBe('claude-sonnet-4-20250514')
  })

  it('swapProvider() calls agent.setModel() with the new model', () => {
    const agentCore = new AgentCore({
      model: makeModel(),
      apiKey: 'sk-primary',
      db,
      yoloMode: false,
      tools: [],
    })

    const piAgent = agentCore.getAgent()
    const setModelSpy = vi.spyOn(piAgent, 'setModel')

    const fallback = makeFallbackProvider()
    agentCore.swapProvider(fallback, 'sk-fallback')

    expect(setModelSpy).toHaveBeenCalledOnce()
    const calledModel = setModelSpy.mock.calls[0][0]
    expect(calledModel.id).toBe('claude-sonnet-4-20250514')
  })

  it('conversation context (messages) is preserved after swap', () => {
    const agentCore = new AgentCore({
      model: makeModel(),
      apiKey: 'sk-primary',
      db,
      yoloMode: false,
      tools: [],
    })

    const piAgent = agentCore.getAgent()
    // Verify messages array reference is the same before and after swap
    const messagesBefore = piAgent.state.messages
    const countBefore = messagesBefore.length

    const fallback = makeFallbackProvider()
    agentCore.swapProvider(fallback, 'sk-fallback')

    const messagesAfter = piAgent.state.messages
    // Messages should not be cleared
    expect(messagesAfter.length).toBe(countBefore)
  })

  it('accepts a ProviderManager in constructor options', () => {
    const pm = new ProviderManager(makeProvider(), makeFallbackProvider())
    const agentCore = new AgentCore({
      model: makeModel(),
      apiKey: 'sk-primary',
      db,
      yoloMode: false,
      tools: [],
      providerManager: pm,
    })

    expect(agentCore.getProviderManager()).toBe(pm)
  })

  it('works without ProviderManager (backward compatible)', () => {
    const agentCore = new AgentCore({
      model: makeModel(),
      apiKey: 'sk-primary',
      db,
      yoloMode: false,
      tools: [],
    })

    expect(agentCore.getProviderManager()).toBeUndefined()
    // Should not throw
    const piAgent = agentCore.getAgent()
    expect(piAgent).toBeDefined()
  })
})

describe('AgentCore.isRetryablePreStreamError', () => {
  let db: Database
  let agentCore: AgentCore

  beforeEach(() => {
    db = initDatabase(':memory:')
    agentCore = new AgentCore({
      model: makeModel(),
      apiKey: 'sk-primary',
      db,
      yoloMode: false,
      tools: [],
    })
  })

  // Access the private method via bracket notation for testing
  function isRetryable(err: unknown): boolean {
    return (agentCore as unknown as { isRetryablePreStreamError: (err: unknown) => boolean }).isRetryablePreStreamError(err)
  }

  it('detects HTTP 429 errors', () => {
    expect(isRetryable(new Error('HTTP 429 Too Many Requests'))).toBe(true)
    expect(isRetryable(new Error('Rate limit exceeded'))).toBe(true)
    expect(isRetryable(new Error('too many requests'))).toBe(true)
  })

  it('detects HTTP 5xx errors', () => {
    expect(isRetryable(new Error('HTTP 500 Internal Server Error'))).toBe(true)
    expect(isRetryable(new Error('HTTP 502 Bad Gateway'))).toBe(true)
    expect(isRetryable(new Error('HTTP 503 Service Unavailable'))).toBe(true)
    expect(isRetryable(new Error('HTTP 504 Gateway Timeout'))).toBe(true)
    expect(isRetryable(new Error('internal server error'))).toBe(true)
    expect(isRetryable(new Error('bad gateway'))).toBe(true)
    expect(isRetryable(new Error('service unavailable'))).toBe(true)
  })

  it('detects connection errors', () => {
    expect(isRetryable(new Error('connect ECONNREFUSED 127.0.0.1:443'))).toBe(true)
    expect(isRetryable(new Error('ECONNRESET'))).toBe(true)
    expect(isRetryable(new Error('getaddrinfo ENOTFOUND api.example.com'))).toBe(true)
    expect(isRetryable(new Error('fetch failed'))).toBe(true)
    expect(isRetryable(new Error('Connection refused'))).toBe(true)
  })

  it('does not retry on other errors', () => {
    expect(isRetryable(new Error('Invalid API key'))).toBe(false)
    expect(isRetryable(new Error('HTTP 401 Unauthorized'))).toBe(false)
    expect(isRetryable(new Error('HTTP 403 Forbidden'))).toBe(false)
    expect(isRetryable(new Error('Model not found'))).toBe(false)
  })
})
