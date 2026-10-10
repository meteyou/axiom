import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { AgentCore } from './agent.js'
import type { UserToolsContext } from './agent.js'
import { initDatabase } from './database.js'
import { updateUserSettings } from './user-settings.js'
import type { Database } from './database.js'
import type { ResponseChunk } from './agent-runtime-types.js'
import type { AgentRuntimeOptions } from './agent-runtime.js'
import { createBaseAgentTools } from './agent-runtime.js'
import { assembleSystemPrompt, ensureMemoryStructure } from './memory.js'

interface FakeRuntime {
  options: AgentRuntimeOptions
  transcript: string[]
  aborted: boolean
  cleared: number
  swaps: number
  lastSwap?: { providerId: string; apiKey: string; modelId?: string }
  systemPrompts: Array<{ username: string; role?: string } | undefined>
}

const { runtimes, gates, providerFixtures } = vi.hoisted(() => ({
  runtimes: [] as unknown[],
  gates: new Map<string, { promise: Promise<void>; release: () => void }>(),
  providerFixtures: { providers: null as unknown[] | null, apiKeyError: null as string | null },
}))

vi.mock('./provider-config.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./provider-config.js')>()
  return {
    ...original,
    loadProviders: () => providerFixtures.providers
      ? { ...original.loadProviders(), providers: providerFixtures.providers }
      : original.loadProviders(),
    loadProvidersDecrypted: () => providerFixtures.providers
      ? { ...original.loadProvidersDecrypted(), providers: providerFixtures.providers }
      : original.loadProvidersDecrypted(),
    getApiKeyForProvider: async (provider: Parameters<typeof original.getApiKeyForProvider>[0]) => {
      if (providerFixtures.apiKeyError) throw new Error(providerFixtures.apiKeyError)
      return original.getApiKeyForProvider(provider)
    },
  }
})

vi.mock('./agent-runtime.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./agent-runtime.js')>()
  return {
    ...original,
    createAgentRuntime: vi.fn((options: AgentRuntimeOptions) => {
      const runtime: FakeRuntime = { options, transcript: [], aborted: false, cleared: 0, swaps: 0, systemPrompts: [] }
      runtimes.push(runtime)
      return {
        async *streamPrompt(rawText: string): AsyncIterable<ResponseChunk> {
          const text = rawText.trim()
          runtime.transcript.push(text)
          yield { type: 'text', text: `echo:${text}` }
          const gate = gates.get(text)
          if (gate) await gate.promise
          yield { type: 'done' }
        },
        refreshSystemPrompt: (_channel: string | undefined, user?: { username: string; role?: string }) => {
          runtime.systemPrompts.push(user)
        },
        getCurrentTimeContext: () => '',
        swapProvider: (provider: { id: string }, apiKey: string, modelId?: string) => {
          runtime.swaps++
          runtime.lastSwap = { providerId: provider.id, apiKey, modelId }
        },
        getProviderManager: () => undefined,
        clearMessages: () => {
          runtime.transcript = []
          runtime.cleared++
        },
        abort: () => { runtime.aborted = true },
        getStateSnapshot: () => ({ modelId: 'mock', toolNames: [], messageCount: runtime.transcript.length }),
        getCurrentModel: () => ({ id: 'mock' }),
        getCurrentApiKey: () => 'key',
        setThinkingLevel: vi.fn(),
        getCurrentProvider: () => null,
      }
    }),
  }
})

function makeModel() {
  return {
    id: 'gpt-4o',
    name: 'GPT-4o',
    api: 'openai-completions' as const,
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    reasoning: false,
    input: ['text' as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
  }
}

function gate(text: string): void {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  gates.set(text, { promise, release })
}

async function drain(stream: AsyncIterable<ResponseChunk>): Promise<ResponseChunk[]> {
  const chunks: ResponseChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

const tick = () => new Promise(resolve => setTimeout(resolve, 10))

describe('multi-user isolation', () => {
  let db: Database
  let alice: number
  let bob: number
  let agent: AgentCore
  let toolContexts: UserToolsContext[]

  const runtimeFor = (userId: number): FakeRuntime =>
    (runtimes as FakeRuntime[]).find(r => r.options.user?.id === userId)!

  beforeEach(() => {
    runtimes.length = 0
    gates.clear()
    providerFixtures.providers = null
    providerFixtures.apiKeyError = null
    toolContexts = []
    db = initDatabase(':memory:')
    alice = Number(db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('alice', 'h', 'admin')").run().lastInsertRowid)
    bob = Number(db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('bob', 'h', 'user')").run().lastInsertRowid)
    agent = new AgentCore({
      model: makeModel(),
      apiKey: 'sk',
      db,
      createUserTools: (context) => {
        toolContexts.push(context)
        return []
      },
    })
  })

  afterEach(async () => {
    await agent.dispose()
    db.close()
  })

  it("never puts user A's messages into user B's transcript", async () => {
    await drain(agent.sendMessage(String(alice), 'alice secret'))
    await drain(agent.sendMessage(String(bob), 'bob hello'))

    expect(runtimeFor(alice).transcript).toEqual(['alice secret'])
    expect(runtimeFor(bob).transcript).toEqual(['bob hello'])
  })

  it("starts B's turn while A's turn is still streaming", async () => {
    gate('alice slow')
    const aliceTurn = drain(agent.sendMessage(String(alice), 'alice slow'))
    await tick()

    await drain(agent.sendMessage(String(bob), 'bob fast'))
    expect(runtimeFor(bob).transcript).toEqual(['bob fast'])

    gates.get('alice slow')!.release()
    await aliceTurn
  })

  it("aborts only the caller's runtime", async () => {
    await drain(agent.sendMessage(String(alice), 'a'))
    await drain(agent.sendMessage(String(bob), 'b'))

    agent.abort(String(alice))

    expect(runtimeFor(alice).aborted).toBe(true)
    expect(runtimeFor(bob).aborted).toBe(false)
  })

  it("leaves B's transcript untouched when A starts a new session", async () => {
    await drain(agent.sendMessage(String(alice), 'a'))
    gate('b slow')
    const bobTurn = drain(agent.sendMessage(String(bob), 'b slow'))
    await tick()

    agent.resetSessionAsync(String(alice))

    expect(runtimeFor(alice).cleared).toBe(1)
    expect(runtimeFor(bob).cleared).toBe(0)
    expect(runtimeFor(bob).transcript).toEqual(['b slow'])
    gates.get('b slow')!.release()
    await bobTurn
  })

  it("leaves B's transcript untouched when A's session ends", async () => {
    await drain(agent.sendMessage(String(alice), 'a'))
    await drain(agent.sendMessage(String(bob), 'b'))

    await agent.resetSession(String(alice))

    expect(runtimeFor(alice).transcript).toEqual([])
    expect(runtimeFor(bob).transcript).toEqual(['b'])
  })

  it('binds the tool context to each runtime user and its own interactive session', async () => {
    gate('alice slow')
    const aliceTurn = drain(agent.sendMessage(String(alice), 'alice slow'))
    await tick()
    await drain(agent.sendMessage(String(bob), 'bob'))

    const aliceCtx = toolContexts.find(c => c.userId === String(alice))!
    const bobCtx = toolContexts.find(c => c.userId === String(bob))!
    expect(aliceCtx.scope).toMatchObject({ id: alice, role: 'admin' })
    expect(bobCtx.scope).toMatchObject({ id: bob, role: 'user' })

    const aliceSession = agent.getSessionManager().getSession(String(alice))!.id
    expect(aliceCtx.getInteractiveSessionId()).toBe(aliceSession)
    expect(bobCtx.getInteractiveSessionId()).toBeNull()

    gates.get('alice slow')!.release()
    await aliceTurn
    expect(aliceCtx.getInteractiveSessionId()).toBeNull()
  })

  it('builds provider_quota per runtime user role', async () => {
    const quotaService = { getSnapshot: () => ({}), refreshProvider: vi.fn() }
    const run = async (userId: number) => {
      const scope = { id: userId, username: 'x', role: userId === alice ? 'admin' as const : 'user' as const, isBootstrapAdmin: false, settings: { chatModel: null, thinkingLevel: 'off' as const, language: 'match' } }
      const tool = createBaseAgentTools({ db, quotaService: quotaService as never, user: scope })
        .find((t: AgentTool) => t.name === 'provider_quota')!
      const result = await tool.execute('call', {})
      return JSON.stringify(result)
    }

    expect(await run(bob)).toContain('only available to admin')
    expect(await run(alice)).not.toContain('only available to admin')
  })

  it('re-checks the provider_quota role on every call', async () => {
    const quotaService = { getSnapshot: () => ({}), refreshProvider: vi.fn() }
    const scope = { id: alice, username: 'alice', role: 'admin' as const, isBootstrapAdmin: true, settings: { chatModel: null, thinkingLevel: 'off' as const, language: 'match' } }
    const tool = createBaseAgentTools({ db, quotaService: quotaService as never, user: scope })
      .find((t: AgentTool) => t.name === 'provider_quota')!

    expect(JSON.stringify(await tool.execute('call', {}))).not.toContain('only available to admin')
    db.prepare("UPDATE users SET role = 'user' WHERE id = ?").run(alice)
    expect(JSON.stringify(await tool.execute('call', {}))).toContain('only available to admin')
  })

  it('passes the runtime user into the runtime options', async () => {
    await drain(agent.sendMessage(String(bob), 'hi'))
    expect(runtimeFor(bob).options.user).toMatchObject({ id: bob, username: 'bob', role: 'user' })
    expect(runtimeFor(bob).systemPrompts.at(-1)).toEqual({ username: 'bob', role: 'user' })
  })

  it('stores the user on new interactive sessions', async () => {
    await drain(agent.sendMessage(String(bob), 'hi'))
    const row = db.prepare("SELECT user_id FROM sessions WHERE type = 'interactive'").get() as { user_id: number }
    expect(row.user_id).toBe(bob)
  })

  it('forwards provider swaps to every live runtime', async () => {
    await drain(agent.sendMessage(String(alice), 'a'))
    await drain(agent.sendMessage(String(bob), 'b'))
    const provider = { id: 'p', type: 'openai', name: 'P', apiKey: 'k', baseUrl: 'https://x/v1', models: [] } as never

    agent.swapProvider(provider, 'key', 'gpt-4o')

    expect((runtimes as FakeRuntime[]).map(r => r.swaps)).toEqual([1, 1])
  })

  it('keeps runtimes on their own model from triggering the global provider fallback', async () => {
    providerFixtures.providers = [{ id: 'own', providerType: 'openai', name: 'Own', apiKey: 'k', baseUrl: 'https://x/v1', defaultModel: 'gpt-4o', enabledModels: ['gpt-4o'] }]
    updateUserSettings(db, bob, { chatModel: { providerId: 'own', modelId: 'gpt-4o' } })

    await drain(agent.sendMessage(String(alice), 'a'))
    await drain(agent.sendMessage(String(bob), 'b'))

    expect(runtimeFor(alice).options.canUseProviderFallback?.()).toBe(true)
    expect(runtimeFor(bob).swaps).toBe(1)
    expect(runtimeFor(bob).options.canUseProviderFallback?.()).toBe(false)
  })

  it('re-checks and refreshes the active model override on every turn', async () => {
    const globalProvider = { id: 'global', providerType: 'openai', name: 'Global', apiKey: 'gk', baseUrl: 'https://g/v1', defaultModel: 'gpt-4o' }
    agent.swapProvider(globalProvider as never, 'gk', 'gpt-4o')
    const own = { id: 'own', providerType: 'openai', name: 'Own', apiKey: 'k1', baseUrl: 'https://x/v1', defaultModel: 'gpt-4o', enabledModels: ['gpt-4o'] }
    providerFixtures.providers = [own]
    updateUserSettings(db, bob, { chatModel: { providerId: 'own', modelId: 'gpt-4o' } })

    await drain(agent.sendMessage(String(bob), 'one'))
    expect(runtimeFor(bob).lastSwap).toEqual({ providerId: 'own', apiKey: 'k1', modelId: 'gpt-4o' })

    providerFixtures.providers = [{ ...own, apiKey: 'k2' }]
    await drain(agent.sendMessage(String(bob), 'two'))
    expect(runtimeFor(bob).lastSwap).toEqual({ providerId: 'own', apiKey: 'k2', modelId: 'gpt-4o' })

    providerFixtures.providers = [{ ...own, apiKey: 'k2', disabled: true }]
    await drain(agent.sendMessage(String(bob), 'three'))
    expect(runtimeFor(bob).lastSwap).toEqual({ providerId: 'global', apiKey: 'gk', modelId: 'gpt-4o' })
    expect(runtimeFor(bob).options.canUseProviderFallback?.()).toBe(true)
  })

  it('fails the turn instead of answering with another model when the own model cannot be applied', async () => {
    providerFixtures.providers = [{ id: 'own', providerType: 'openai', name: 'Own', apiKey: 'k', baseUrl: 'https://x/v1', defaultModel: 'gpt-4o', enabledModels: ['gpt-4o'] }]
    updateUserSettings(db, bob, { chatModel: { providerId: 'own', modelId: 'gpt-4o' } })
    providerFixtures.apiKeyError = 'token refresh failed'

    const chunks = await drain(agent.sendMessage(String(bob), 'hi'))

    expect(chunks[0]).toMatchObject({ type: 'error' })
    expect((chunks[0] as { error: string }).error).toContain('own/gpt-4o')
    expect(chunks.at(-1)).toEqual({ type: 'done' })
    expect(runtimeFor(bob).transcript).toEqual([])
    expect(runtimeFor(bob).swaps).toBe(0)
  })
})

describe('system prompt <current_user>', () => {
  let dir: string

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('contains username and role', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-prompt-'))
    ensureMemoryStructure(dir)
    const prompt = assembleSystemPrompt({ memoryDir: dir, currentUser: { username: 'bob', role: 'user' } })
    expect(prompt).toContain('<current_user>\nUsername: bob\nRole: user\n</current_user>')
  })
})
