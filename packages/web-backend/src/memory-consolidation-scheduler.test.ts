import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase, TaskStore, initTasksTable } from '@openagent/core'
import type { AgentCore, Database, Task, ProviderConfig } from '@openagent/core'
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
    defaultModel: 'gpt-4o',
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
  }
}

beforeEach(() => {
  tempDataDir = path.join(os.tmpdir(), `openagent-consolidation-scheduler-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
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
      expect(startedTask.task.name).toBe('Nightly Memory Consolidation')
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
