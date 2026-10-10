import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase, TaskStore, initTasksTable } from '@axiom/core'
import type { AgentCore, Database, Task, ProviderConfig } from '@axiom/core'
import { MemoryConsolidationScheduler, DEFAULT_CONSOLIDATION_SETTINGS } from './memory-consolidation-scheduler.js'

let tempDataDir: string
let previousDataDir: string | undefined
let db: Database

function writeConfig(name: string, value: object): void {
  const configDir = path.join(tempDataDir, 'config')
  fs.mkdirSync(configDir, { recursive: true })
  fs.writeFileSync(path.join(configDir, name), JSON.stringify(value, null, 2) + '\n', 'utf-8')
}

function makeProvider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'test-provider',
    name: 'TestProvider',
    type: 'openai-completions',
    providerType: 'openai',
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-test',
    enabledModels: ['gpt-4o'],
    ...overrides,
  }
}

function createMockTaskRuntime(taskStore: TaskStore) {
  const startedTasks: Array<{ task: Task; provider: ProviderConfig }> = []
  let taskCompletionCallback: ((taskId: string) => void) | null = null

  return {
    startedTasks,
    setTaskCompletionCallback(cb: (taskId: string) => void) {
      taskCompletionCallback = cb
    },
    create: vi.fn((input) => taskStore.create(input)),
    getById: vi.fn((taskId: string) => taskStore.getById(taskId)),
    start: vi.fn(async (task: Task, provider: ProviderConfig) => {
      startedTasks.push({ task, provider })
      if (taskCompletionCallback) {
        setTimeout(() => taskCompletionCallback?.(task.id), 10)
      }
      return task.id
    }),
    abort: vi.fn(),
  }
}

beforeEach(() => {
  tempDataDir = path.join(os.tmpdir(), `axiom-consolidation-scheduler-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  fs.mkdirSync(tempDataDir, { recursive: true })
  previousDataDir = process.env.DATA_DIR
  process.env.DATA_DIR = tempDataDir

  db = initDatabase(':memory:')
  initTasksTable(db)
})

afterEach(() => {
  if (previousDataDir !== undefined) {
    process.env.DATA_DIR = previousDataDir
  } else {
    delete process.env.DATA_DIR
  }
  if (tempDataDir) {
    fs.rmSync(tempDataDir, { recursive: true, force: true })
  }
})

describe('MemoryConsolidationScheduler', () => {
  describe('constructor and basic lifecycle', () => {
    it('starts and stops without errors', () => {
      const scheduler = new MemoryConsolidationScheduler({ db })
      scheduler.start()
      scheduler.stop()
    })

    it('restart reloads settings', () => {
      const scheduler = new MemoryConsolidationScheduler({ db })
      scheduler.start()

      writeConfig('settings.json', {
        memoryConsolidation: { enabled: true, runAtHour: 4 },
      })

      scheduler.restart()
      const snapshot = scheduler.getSnapshot()
      expect(snapshot.enabled).toBe(true)
      expect(snapshot.runAtHour).toBe(4)

      scheduler.stop()
    })
  })

  describe('getSnapshot', () => {
    it('returns default values initially', () => {
      const scheduler = new MemoryConsolidationScheduler({ db })
      const snapshot = scheduler.getSnapshot()

      expect(snapshot.enabled).toBe(DEFAULT_CONSOLIDATION_SETTINGS.enabled)
      expect(snapshot.runAtHour).toBe(DEFAULT_CONSOLIDATION_SETTINGS.runAtHour)
      expect(snapshot.lookbackDays).toBe(DEFAULT_CONSOLIDATION_SETTINGS.lookbackDays)
      expect(snapshot.lastRun).toBeNull()
      expect(snapshot.lastResult).toBeNull()
    })
  })

  describe('executeConsolidation via runNow', () => {
    it('returns error result when task runtime is not available', async () => {
      const scheduler = new MemoryConsolidationScheduler({ db })

      const result = await scheduler.runNow()

      expect(result.updated).toBe(false)
      expect(result.reason).toContain('Task runtime not available')
    })

    it('returns error result when no provider is available', async () => {
      const taskStore = new TaskStore(db)
      const taskRuntime = createMockTaskRuntime(taskStore)

      const scheduler = new MemoryConsolidationScheduler({
        db,
        taskRuntime,
        getDefaultProvider: () => null,
      })

      const result = await scheduler.runNow()

      expect(result.updated).toBe(false)
      expect(result.reason).toContain('No provider available')
      expect(taskRuntime.start).not.toHaveBeenCalled()
    })

    it('creates and starts a consolidation task via task runtime boundary', async () => {
      const taskStore = new TaskStore(db)
      const taskRuntime = createMockTaskRuntime(taskStore)
      const provider = makeProvider()

      taskRuntime.setTaskCompletionCallback((taskId: string) => {
        taskStore.update(taskId, {
          status: 'completed',
          resultStatus: 'silent',
          resultSummary: 'Nothing to report.',
          completedAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
        })
      })

      const scheduler = new MemoryConsolidationScheduler({
        db,
        taskRuntime,
        getDefaultProvider: () => provider,
      })

      const result = await scheduler.runNow()

      expect(taskRuntime.create).toHaveBeenCalledOnce()
      expect(taskRuntime.start).toHaveBeenCalledOnce()

      const startedTask = taskRuntime.startedTasks[0]
      // Manual runNow() always includes the compaction pass
      expect(startedTask.task.name).toBe('Nightly Memory Consolidation + Compaction')
      expect(startedTask.task.prompt).toContain('Weekly compaction run')
      expect(startedTask.task.triggerType).toBe('consolidation')
      expect(startedTask.task.triggerSourceId).toBe('memory-consolidation')
      expect(startedTask.task.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
      expect(startedTask.provider).toBe(provider)

      expect(startedTask.task.prompt).toContain('nightly memory consolidation')
      expect(startedTask.task.prompt).toContain('daily files')
      expect(startedTask.task.prompt).toContain('MEMORY.md')
      expect(startedTask.task.prompt).toContain('project notes')
      expect(startedTask.task.prompt).toContain('user profiles')
      expect(startedTask.task.prompt).toContain('read_chat_history')
      expect(startedTask.task.prompt).toContain('Additional input: Extracted Facts')
      expect(startedTask.task.prompt).toContain('search_memories')
      expect(startedTask.task.prompt).toContain('Do NOT write to the memories table')
      expect(startedTask.task.prompt).toContain('if no relevant facts are found, continue with the daily files alone as before')
      expect(startedTask.task.prompt).toContain('Consolidation Rules')
      expect(startedTask.task.prompt).toContain('Memory Consolidation Rules')

      expect(result.updated).toBe(false)
    })

    it('completes silently when task finishes with silent status', async () => {
      const taskStore = new TaskStore(db)
      const taskRuntime = createMockTaskRuntime(taskStore)
      const provider = makeProvider()

      taskRuntime.setTaskCompletionCallback((taskId: string) => {
        taskStore.update(taskId, {
          status: 'completed',
          resultStatus: 'silent',
          resultSummary: 'Nothing to update.',
          completedAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
          promptTokens: 100,
          completionTokens: 50,
        })
      })

      const scheduler = new MemoryConsolidationScheduler({
        db,
        taskRuntime,
        getDefaultProvider: () => provider,
      })

      const result = await scheduler.runNow()

      expect(result.updated).toBe(false)
      expect(result.usage).toEqual({ input: 100, output: 50 })
    })

    it('refreshes system prompt after task completion when agentCore is set', async () => {
      const taskStore = new TaskStore(db)
      const taskRuntime = createMockTaskRuntime(taskStore)
      const provider = makeProvider()
      const mockAgentCore = { refreshSystemPrompt: vi.fn() }

      taskRuntime.setTaskCompletionCallback((taskId: string) => {
        taskStore.update(taskId, {
          status: 'completed',
          resultStatus: 'completed',
          resultSummary: 'Updated MEMORY.md.',
          completedAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
        })
      })

      const scheduler = new MemoryConsolidationScheduler({
        db,
        agentCore: mockAgentCore as unknown as AgentCore,
        taskRuntime,
        getDefaultProvider: () => provider,
      })

      await scheduler.runNow()

      expect(mockAgentCore.refreshSystemPrompt).toHaveBeenCalledOnce()
    })

    it('deduplicates concurrent runNow calls', async () => {
      const taskStore = new TaskStore(db)
      const taskRuntime = createMockTaskRuntime(taskStore)
      const provider = makeProvider()

      taskRuntime.setTaskCompletionCallback((taskId: string) => {
        taskStore.update(taskId, {
          status: 'completed',
          resultStatus: 'silent',
          resultSummary: 'Done.',
          completedAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
        })
      })

      const scheduler = new MemoryConsolidationScheduler({
        db,
        taskRuntime,
        getDefaultProvider: () => provider,
      })

      const [result1, result2] = await Promise.all([
        scheduler.runNow(),
        scheduler.runNow(),
      ])

      expect(taskRuntime.start).toHaveBeenCalledOnce()
      expect(result1).toBe(result2)
    })

    it('records lastRun and lastResult after execution', async () => {
      const taskStore = new TaskStore(db)
      const taskRuntime = createMockTaskRuntime(taskStore)
      const provider = makeProvider()

      taskRuntime.setTaskCompletionCallback((taskId: string) => {
        taskStore.update(taskId, {
          status: 'completed',
          resultStatus: 'silent',
          completedAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
        })
      })

      const scheduler = new MemoryConsolidationScheduler({
        db,
        taskRuntime,
        getDefaultProvider: () => provider,
      })

      expect(scheduler.getSnapshot().lastRun).toBeNull()

      await scheduler.runNow()

      const snapshot = scheduler.getSnapshot()
      expect(snapshot.lastRun).not.toBeNull()
      expect(snapshot.lastResult).not.toBeNull()
    })

    it('logs activity to tool_calls table', async () => {
      const taskStore = new TaskStore(db)
      const taskRuntime = createMockTaskRuntime(taskStore)
      const provider = makeProvider()

      taskRuntime.setTaskCompletionCallback((taskId: string) => {
        taskStore.update(taskId, {
          status: 'completed',
          resultStatus: 'silent',
          completedAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
        })
      })

      const scheduler = new MemoryConsolidationScheduler({
        db,
        taskRuntime,
        getDefaultProvider: () => provider,
      })

      await scheduler.runNow()

      const rows = db.prepare(
        "SELECT * FROM tool_calls WHERE tool_name = 'memory_consolidation'"
      ).all() as Array<{ session_id: string }>
      expect(rows.length).toBeGreaterThanOrEqual(1)
      expect(rows[0].session_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    })
  })

  describe('setters', () => {
    it('setAgentCore updates the agentCore reference', () => {
      const scheduler = new MemoryConsolidationScheduler({ db })
      const mockAgentCore = { refreshSystemPrompt: vi.fn() }
      scheduler.setAgentCore(mockAgentCore as unknown as AgentCore)
    })

    it('setTaskRuntime updates the taskRuntime reference', () => {
      const scheduler = new MemoryConsolidationScheduler({ db })
      const taskStore = new TaskStore(db)
      const taskRuntime = createMockTaskRuntime(taskStore)
      scheduler.setTaskRuntime(taskRuntime)
    })
  })
})

describe('MemoryConsolidationScheduler multi-user', () => {
  function addUser(username: string, role = 'user'): number {
    return Number(db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(username, 'h', role).lastInsertRowid)
  }

  function writeDaily(dir: string, content: string): void {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${new Date().toISOString().split('T')[0]}.md`), content, 'utf-8')
  }

  it('runs users sequentially with the bootstrap admin last and skips users without entries', async () => {
    addUser('admin', 'admin')
    const bobId = addUser('bob')
    addUser('carol')
    writeDaily(path.join(tempDataDir, 'users', 'bob', 'daily'), 'Bob likes tea')

    const taskStore = new TaskStore(db)
    const taskRuntime = createMockTaskRuntime(taskStore)
    taskRuntime.setTaskCompletionCallback((taskId: string) => {
      taskStore.update(taskId, { status: 'completed', resultStatus: 'silent', completedAt: new Date().toISOString().replace('T', ' ').slice(0, 19) })
    })
    const scheduler = new MemoryConsolidationScheduler({ db, taskRuntime, getDefaultProvider: () => makeProvider() })

    await scheduler.runNow()

    expect(taskRuntime.startedTasks).toHaveLength(2)
    const [userRun, adminRun] = taskRuntime.startedTasks.map(s => s.task)
    expect(userRun.ownerUserId).toBe(bobId)
    expect(adminRun.ownerUserId).toBe(1)

    expect(userRun.prompt).toContain(path.join(tempDataDir, 'users', 'bob', 'PROFILE.md'))
    expect(userRun.prompt).not.toContain('Wiki Health Check')
    expect(userRun.prompt).not.toContain('Global steps')
    expect(userRun.prompt).not.toContain('Weekly compaction run')
    expect(userRun.prompt).not.toContain('Remove outdated or superseded information from MEMORY.md')
    expect(userRun.prompt).toContain('Only ADD general lessons to MEMORY.md')
    expect(userRun.prompt).toContain(path.join(tempDataDir, 'users', 'bob') + '/')
    expect(adminRun.prompt).toContain('Remove outdated or superseded information from MEMORY.md')
    expect(adminRun.prompt).toContain(path.join(tempDataDir, 'users', 'bob', 'PROFILE.md'))
    expect(adminRun.prompt).toContain(path.join(tempDataDir, 'users', 'carol', 'PROFILE.md'))
    expect(userRun.prompt).not.toContain(path.join(tempDataDir, 'users', 'carol', 'PROFILE.md'))
    const sessionCount = (db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE type = 'consolidation'").get() as { n: number }).n
    expect(sessionCount).toBe(2)
    const logRow = db.prepare("SELECT session_id, status FROM tool_calls WHERE tool_name = 'memory_consolidation'").get() as { session_id: string; status: string }
    expect(logRow.session_id).toBe(adminRun.sessionId)
    expect(logRow.status).toBe('success')
    expect(adminRun.prompt).toContain('Wiki Health Check')
    expect(adminRun.prompt).toContain('Global steps')
    expect(scheduler.getSnapshot().lastResult).not.toBeNull()
  }, 30000)

  it('logs status error when a run fails but continues the sequence', async () => {
    addUser('admin', 'admin')
    addUser('bob')
    writeDaily(path.join(tempDataDir, 'users', 'bob', 'daily'), 'Bob likes tea')

    const taskStore = new TaskStore(db)
    const taskRuntime = createMockTaskRuntime(taskStore)
    taskRuntime.setTaskCompletionCallback((taskId: string) => {
      taskStore.update(taskId, { status: 'completed', resultStatus: 'silent', completedAt: new Date().toISOString().replace('T', ' ').slice(0, 19) })
    })
    taskRuntime.start.mockImplementationOnce(async () => { throw new Error('boom') })
    const scheduler = new MemoryConsolidationScheduler({ db, taskRuntime, getDefaultProvider: () => makeProvider() })

    await scheduler.runNow()

    expect(taskRuntime.startedTasks).toHaveLength(1)
    const logRow = db.prepare("SELECT status FROM tool_calls WHERE tool_name = 'memory_consolidation'").get() as { status: string }
    expect(logRow.status).toBe('error')
  }, 30000)

  it('counts a run that ends in failed status as failed', async () => {
    addUser('admin', 'admin')
    addUser('bob')
    writeDaily(path.join(tempDataDir, 'users', 'bob', 'daily'), 'Bob likes tea')

    const taskStore = new TaskStore(db)
    const taskRuntime = createMockTaskRuntime(taskStore)
    let first = true
    taskRuntime.setTaskCompletionCallback((taskId: string) => {
      const status = first ? 'failed' : 'completed'
      first = false
      taskStore.update(taskId, { status, resultStatus: status === 'failed' ? 'failed' : 'silent', errorMessage: status === 'failed' ? 'provider error' : undefined })
    })
    const scheduler = new MemoryConsolidationScheduler({ db, taskRuntime, getDefaultProvider: () => makeProvider() })

    await scheduler.runNow()

    expect(taskRuntime.startedTasks).toHaveLength(2)
    const logRow = db.prepare("SELECT status, output FROM tool_calls WHERE tool_name = 'memory_consolidation'").get() as { status: string; output: string }
    expect(logRow.status).toBe('error')
    expect(JSON.parse(logRow.output).failedRuns).toEqual(['bob'])
  }, 30000)

  it('aborts a timed-out run before starting the next one', async () => {
    addUser('admin', 'admin')
    addUser('bob')
    writeDaily(path.join(tempDataDir, 'users', 'bob', 'daily'), 'Bob likes tea')

    const taskStore = new TaskStore(db)
    const taskRuntime = createMockTaskRuntime(taskStore)
    const realNow = Date.now.bind(Date)
    let offset = 0
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset)
    let startCount = 0
    taskRuntime.setTaskCompletionCallback((taskId: string) => {
      startCount++
      if (startCount === 1) {
        offset = 31 * 60 * 1000
        return
      }
      taskStore.update(taskId, { status: 'completed', resultStatus: 'silent' })
    })
    const scheduler = new MemoryConsolidationScheduler({ db, taskRuntime, getDefaultProvider: () => makeProvider() })

    try {
      await scheduler.runNow()
    } finally {
      nowSpy.mockRestore()
    }

    const [userRun] = taskRuntime.startedTasks.map(s => s.task)
    expect(taskRuntime.abort).toHaveBeenCalledWith(userRun.id, expect.stringContaining('timed out'))
    expect(taskRuntime.abort.mock.invocationCallOrder[0]).toBeLessThan(taskRuntime.start.mock.invocationCallOrder[1])
    const logRow = db.prepare("SELECT status, output FROM tool_calls WHERE tool_name = 'memory_consolidation'").get() as { status: string; output: string }
    expect(logRow.status).toBe('error')
    expect(JSON.parse(logRow.output).failedRuns).toEqual(['bob'])
  }, 30000)
})
