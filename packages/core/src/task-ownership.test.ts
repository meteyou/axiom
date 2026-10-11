import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import { migrateTaskOwners, TaskStore } from './task-store.js'
import { createScopedTools } from './scoped-tools.js'
import { resolveUserScope } from './user-scope.js'
import { createMemory } from './memories-store.js'
import { SessionManager } from './session-manager.js'
import { TaskRunner } from './task-runner.js'
import type { TaskRuntimeTaskBoundary } from './task-runtime.js'
import type { ProviderConfig } from './provider-config.js'

const { agentCalls } = vi.hoisted(() => ({
  agentCalls: [] as Array<{ initialState: { systemPrompt: string; tools: Array<{ name: string }> } }>,
}))

vi.mock('@earendil-works/pi-agent-core', () => ({
  Agent: vi.fn().mockImplementation((options: (typeof agentCalls)[number]) => {
    agentCalls.push(options)
    return {
      subscribe: vi.fn(() => () => {}),
      prompt: vi.fn(() => new Promise<void>(() => {})),
      abort: vi.fn(),
      state: { messages: [] },
    }
  }),
}))

const provider: ProviderConfig = {
  id: 'p',
  name: 'p',
  type: 'openai',
  providerType: 'openai',
  provider: 'openai',
  baseUrl: 'http://localhost:1',
  apiKey: 'k',
  enabledModels: ['m'],
  models: [],
  status: 'connected',
  authMethod: 'api-key',
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map(c => c.text ?? '').join('')
}

describe('task ownership', () => {
  let db: Database
  let dataDir: string
  let workspaceDir: string
  let previousEnv: { data?: string; workspace?: string }

  beforeEach(() => {
    previousEnv = { data: process.env.DATA_DIR, workspace: process.env.WORKSPACE_DIR }
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-task-owner-'))
    workspaceDir = path.join(dataDir, 'workspace')
    process.env.DATA_DIR = dataDir
    process.env.WORKSPACE_DIR = workspaceDir
    db = initDatabase(':memory:')
    db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1, 'admin', 'h', 'admin'), (2, 'alice', 'h', 'user'), (3, 'bob', 'h', 'user')").run()
    agentCalls.length = 0
  })

  afterEach(() => {
    db.close()
    for (const [key, value] of [['DATA_DIR', previousEnv.data], ['WORKSPACE_DIR', previousEnv.workspace]] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  describe('migration', () => {
    it('attributes tasks to their session lineage user, else the bootstrap admin, and is idempotent', () => {
      db.prepare("INSERT INTO sessions (id, user_id, session_user, source, type) VALUES ('s-chat', 2, '2', 'web', 'interactive')").run()
      db.prepare("INSERT INTO sessions (id, source, type, parent_session_id) VALUES ('s-task', 'system', 'task', 's-chat')").run()
      db.prepare("INSERT INTO sessions (id, source, type) VALUES ('s-orphan', 'system', 'task')").run()
      const insert = db.prepare("INSERT INTO tasks (id, name, prompt, status, trigger_type, session_id) VALUES (?, 'n', 'p', 'completed', 'agent', ?)")
      insert.run('lineage', 's-task')
      insert.run('orphan', 's-orphan')
      insert.run('nosession', null)
      db.prepare('UPDATE tasks SET owner_user_id = NULL').run()

      migrateTaskOwners(db)
      const owners = () => Object.fromEntries(
        (db.prepare('SELECT id, owner_user_id FROM tasks').all() as Array<{ id: string; owner_user_id: number }>)
          .map(r => [r.id, r.owner_user_id]),
      )
      expect(owners()).toEqual({ lineage: 2, orphan: 1, nosession: 1 })

      db.prepare("UPDATE tasks SET owner_user_id = 3 WHERE id = 'lineage'").run()
      migrateTaskOwners(db)
      expect(owners().lineage).toBe(3)
    })

    it('defaults new tasks without an owner to the bootstrap admin', () => {
      const task = new TaskStore(db).create({ name: 'n', prompt: 'p', triggerType: 'cronjob' })
      expect(task.ownerUserId).toBe(1)
    })
  })

  describe('agent tools', () => {
    let store: TaskStore
    let aborted: string[]
    let runtime: TaskRuntimeTaskBoundary

    beforeEach(() => {
      store = new TaskStore(db)
      aborted = []
      runtime = {
        create: input => store.create(input),
        getById: id => store.getById(id),
        list: filters => store.list(filters),
        update: (id, updates) => store.update(id, updates),
        start: async task => task.id,
        resume: async () => true,
        abort: id => { aborted.push(id) },
        isRunning: () => true,
        getRunningIds: () => [],
        isPaused: () => true,
        getPausedIds: () => [],
        cleanupStalePaused: () => 0,
        recover: async () => ({ resumed: 0, failed: 0 }),
      }
    })

    function toolsFor(userId: number): Map<string, AgentTool> {
      const scope = resolveUserScope(db, userId)!
      const tools = createScopedTools(scope, {
        db,
        taskTools: {
          taskRuntime: runtime,
          getDefaultProvider: () => provider,
          resolveProvider: () => provider,
          defaultMaxDurationMinutes: 10,
          maxDurationMinutesCap: 20,
        },
      })
      return new Map(tools.map(t => [t.name, t]))
    }

    async function run(userId: number, name: string, params: Record<string, unknown> = {}): Promise<string> {
      const tool = toolsFor(userId).get(name)!
      return textOf(await tool.execute('call', params) as never)
    }

    it('scopes search_memories and read_chat_history of a task agent to its owner', async () => {
      createMemory(db, 2, null, 'alice likes pineapple pizza')
      createMemory(db, 3, null, 'bob likes pineapple juice')
      db.prepare("INSERT INTO sessions (id, user_id, session_user, source, type) VALUES ('sa', 2, '2', 'web', 'interactive'), ('sb', 3, '3', 'web', 'interactive')").run()
      db.prepare("INSERT INTO chat_messages (session_id, user_id, role, content) VALUES ('sa', 2, 'user', 'hello from alice'), ('sb', 3, 'user', 'hello from bob')").run()

      const facts = await run(2, 'search_memories', { query: 'pineapple' })
      expect(facts).toContain('alice likes')
      expect(facts).not.toContain('bob likes')

      const history = await run(2, 'read_chat_history', {})
      expect(history).toContain('hello from alice')
      expect(history).not.toContain('hello from bob')
    })

    it('creates tasks owned by the calling user', async () => {
      const text = await run(2, 'create_task', { name: 'Alice job', prompt: 'do it' })
      expect(text).toContain('Background task started')
      expect(store.list().find(t => t.name === 'Alice job')?.ownerUserId).toBe(2)
    })

    it('lists only own tasks for a regular user', async () => {
      store.create({ name: 'alice task', prompt: 'p', triggerType: 'user', ownerUserId: 2 })
      store.create({ name: 'bob task', prompt: 'p', triggerType: 'user', ownerUserId: 3 })
      const text = await run(2, 'list_tasks')
      expect(text).toContain('alice task')
      expect(text).not.toContain('bob task')
    })

    it('shows the admin only title, owner and status of foreign tasks', async () => {
      store.create({ name: 'bob task', prompt: 'secret prompt', triggerType: 'user', ownerUserId: 3 })
      const own = store.create({ name: 'admin task', prompt: 'p', triggerType: 'user', ownerUserId: 1 })
      store.update(own.id, { resultSummary: 'admin result' })
      const foreign = store.create({ name: 'bob done', prompt: 'p', triggerType: 'user', ownerUserId: 3 })
      store.update(foreign.id, { status: 'completed', resultSummary: 'bobs private result' })

      const text = await run(1, 'list_tasks')
      expect(text).toContain('bob task')
      expect(text).toContain('Owner: bob')
      expect(text).toContain('[RUNNING]')
      expect(text).toContain('[COMPLETED] bob done')
      expect(text).not.toContain('secret prompt')
      expect(text).not.toContain('bobs private result')
      expect(text).toContain('admin task')
    })

    it('stops own tasks and lets an admin stop any task', async () => {
      const alices = store.create({ name: 'a', prompt: 'p', triggerType: 'user', ownerUserId: 2 })
      expect(await run(2, 'stop_task', { task_id: alices.id })).toContain('has been stopped')
      expect(await run(1, 'stop_task', { task_id: alices.id })).toContain('has been stopped')
      expect(aborted).toEqual([alices.id, alices.id])
    })

    it('does not let a regular user stop or even find a foreign task', async () => {
      const bobs = store.create({ name: 'b', prompt: 'p', triggerType: 'user', ownerUserId: 3 })
      expect(await run(2, 'stop_task', { task_id: bobs.id })).toContain('not found')
      expect(aborted).toEqual([])
    })

    it('applies a role change to tools that were built before it', async () => {
      const bobs = store.create({ name: 'b', prompt: 'p', triggerType: 'user', ownerUserId: 3 })
      const adminTools = toolsFor(1)
      db.prepare("UPDATE users SET role = 'user' WHERE id = 1").run()

      expect(textOf(await adminTools.get('stop_task')!.execute('call', { task_id: bobs.id }) as never)).toContain('not found')
      expect(aborted).toEqual([])
    })

    it('gives send_file_to_user only to tools of an interactive turn', () => {
      expect(toolsFor(2).has('send_file_to_user')).toBe(false)
      const chatTools = createScopedTools(resolveUserScope(db, 2)!, {
        db,
        taskTools: { taskRuntime: runtime, getDefaultProvider: () => provider, resolveProvider: () => provider, defaultMaxDurationMinutes: 10, maxDurationMinutesCap: 20 },
        getInteractiveSessionId: () => 'chat-session',
      })
      expect(chatTools.some(tool => tool.name === 'send_file_to_user')).toBe(true)
    })

    it('rejects resuming foreign tasks for everyone', async () => {
      const bobs = store.create({ name: 'b', prompt: 'p', triggerType: 'user', ownerUserId: 3 })
      store.update(bobs.id, { status: 'paused' })
      expect(await run(2, 'resume_task', { task_id: bobs.id, message: 'x' })).toContain('not found')
      expect(await run(1, 'resume_task', { task_id: bobs.id, message: 'x' })).toContain('only its owner can resume')
      expect(await run(3, 'resume_task', { task_id: bobs.id, message: 'x' })).toContain('has been resumed')
    })
  })

  describe('task runner', () => {
    it('builds each task\'s tools and prompt for its owner', async () => {
      db.prepare("INSERT INTO sessions (id, source, type) VALUES ('x', 'system', 'task')").run()
      const sessionManager = new SessionManager({ db })
      const seenScopes: string[] = []
      const runner = new TaskRunner({
        db,
        buildModel: () => ({}) as never,
        getApiKey: async () => 'k',
        memoryDir: path.join(dataDir, 'memory'),
        createTools: ({ scope }) => {
          seenScopes.push(scope.username)
          return [{ name: `tool_for_${scope.username}`, description: '', parameters: {}, execute: async () => '' }] as unknown as AgentTool[]
        },
        onTaskComplete: () => {},
        sessionManager,
      })
      const store = runner.getStore()
      const task = store.create({ name: 'Alice', prompt: 'do alice stuff', triggerType: 'user', ownerUserId: 2 })
      await runner.startTask(task, provider)

      expect(seenScopes).toEqual(['alice'])
      const call = agentCalls[0]
      expect(call.initialState.tools.map(t => t.name)).toEqual(['tool_for_alice'])
      expect(call.initialState.systemPrompt).toContain(path.join(workspaceDir, 'alice'))
      expect(call.initialState.systemPrompt).toContain(path.join(dataDir, 'users', 'alice', 'PROFILE.md'))
      expect(call.initialState.systemPrompt).toContain('MEMORY.md, the wiki and skills are shared by all users')
      const session = db.prepare('SELECT user_id, session_user FROM sessions WHERE id = ?').get(store.getById(task.id)!.sessionId) as { user_id: number; session_user: string }
      expect(session).toEqual({ user_id: 2, session_user: '2' })

      runner.dispose()
    })

    it('fails a task whose owner was deleted instead of running it for someone else', async () => {
      const seenScopes: string[] = []
      const runner = new TaskRunner({
        db,
        buildModel: () => ({}) as never,
        getApiKey: async () => 'k',
        createTools: ({ scope }) => {
          seenScopes.push(scope.username)
          return []
        },
        onTaskComplete: () => {},
        sessionManager: new SessionManager({ db }),
      })
      const store = runner.getStore()
      const task = store.create({ name: 'Orphan', prompt: 'x', triggerType: 'user', ownerUserId: 3 })
      db.prepare('DELETE FROM users WHERE id = 3').run()

      await expect(runner.startTask(task, provider)).rejects.toThrow('no longer exists')
      expect(seenScopes).toEqual([])
      expect(agentCalls).toHaveLength(0)
      expect(store.getById(task.id)!.status).toBe('failed')

      runner.dispose()
    })
  })
})
