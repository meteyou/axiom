import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase, TaskStore, initTasksTable } from '@openagent/core'
import type { Database, Task, ProviderConfig } from '@openagent/core'
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

/** Minimal mock TaskRunner that records startTask calls */
function createMockTaskRunner() {
  const startedTasks: Array<{ task: Task; provider: ProviderConfig }> = []
  let taskCompletionCallback: ((taskId: string) => void) | null = null

  return {
    startedTasks,
    setTaskCompletionCallback(cb: (taskId: string) => void) {
      taskCompletionCallback = cb
    },
    startTask: vi.fn(async (task: Task, provider: ProviderConfig) => {
      startedTasks.push({ task, provider })
      // Simulate async completion — mark task as completed in DB after a tick
      if (taskCompletionCallback) {
        setTimeout(() => taskCompletionCallback!(task.id), 10)
      }
      return task.id
    }),
    isRunning: vi.fn(() => false),
    getRunningTaskIds: vi.fn(() => []),
    getStore: vi.fn(),
    abortTask: vi.fn(),
    dispose: vi.fn(),
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

      // Write enabled settings
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
    it('returns error result when TaskStore is not available', async () => {
      const scheduler = new MemoryConsolidationScheduler({ db })

      const result = await scheduler.runNow()

      expect(result.updated).toBe(false)
      expect(result.reason).toContain('TaskStore or TaskRunner not available')
    })

    it('returns error result when TaskRunner is not available', async () => {
      const taskStore = new TaskStore(db)
      const scheduler = new MemoryConsolidationScheduler({
        db,
        taskStore,
        taskRunner: null,
      })

      const result = await scheduler.runNow()

      expect(result.updated).toBe(false)
      expect(result.reason).toContain('TaskStore or TaskRunner not available')
    })

    it('returns error result when no provider is available', async () => {
      const taskStore = new TaskStore(db)
      const mockRunner = createMockTaskRunner()

      const scheduler = new MemoryConsolidationScheduler({
        db,
        taskStore,
        taskRunner: mockRunner as any,
        getDefaultProvider: () => null,
      })

      const result = await scheduler.runNow()

      expect(result.updated).toBe(false)
      expect(result.reason).toContain('No provider available')
      expect(mockRunner.startTask).not.toHaveBeenCalled()
    })

    it('creates a task via TaskStore and starts it via TaskRunner', async () => {
      const taskStore = new TaskStore(db)
      const mockRunner = createMockTaskRunner()
      const provider = makeProvider()

      // Set up mock to complete the task after starting
      mockRunner.setTaskCompletionCallback((taskId: string) => {
        taskStore.update(taskId, {
          status: 'completed',
          resultStatus: 'silent',
          resultSummary: 'Nothing to report.',
          completedAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
        })
      })

      const scheduler = new MemoryConsolidationScheduler({
        db,
        taskStore,
        taskRunner: mockRunner as any,
        getDefaultProvider: () => provider,
      })

      const result = await scheduler.runNow()

      // Verify task was created and started
      expect(mockRunner.startTask).toHaveBeenCalledOnce()
      const startedTask = mockRunner.startedTasks[0]
      expect(startedTask.task.name).toBe('Nightly Memory Consolidation')
      expect(startedTask.task.triggerType).toBe('consolidation')
      expect(startedTask.task.triggerSourceId).toBe('memory-consolidation')
      expect(startedTask.task.sessionId).toMatch(/^nightly-consolidation-\d+$/)
      expect(startedTask.provider).toBe(provider)

      // Verify the prompt contains consolidation instructions
      expect(startedTask.task.prompt).toContain('nightly memory consolidation')
      expect(startedTask.task.prompt).toContain('daily files')
      expect(startedTask.task.prompt).toContain('MEMORY.md')
      expect(startedTask.task.prompt).toContain('project notes')
      expect(startedTask.task.prompt).toContain('user profiles')
      expect(startedTask.task.prompt).toContain('read_chat_history')
      // Verify it embeds the consolidation rules from CONSOLIDATION.md
      expect(startedTask.task.prompt).toContain('Consolidation Rules')
      expect(startedTask.task.prompt).toContain('Memory Consolidation Rules')

      // Verify result
      expect(result.updated).toBe(false) // silent completion = not updated
    })

    it('completes silently when task finishes with silent status', async () => {
      const taskStore = new TaskStore(db)
      const mockRunner = createMockTaskRunner()
      const provider = makeProvider()

      mockRunner.setTaskCompletionCallback((taskId: string) => {
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
        taskStore,
        taskRunner: mockRunner as any,
        getDefaultProvider: () => provider,
      })

      const result = await scheduler.runNow()

      expect(result.updated).toBe(false)
      expect(result.usage).toEqual({ input: 100, output: 50 })
    })

    it('refreshes system prompt after task completion when agentCore is set', async () => {
      const taskStore = new TaskStore(db)
      const mockRunner = createMockTaskRunner()
      const provider = makeProvider()
      const mockAgentCore = { refreshSystemPrompt: vi.fn() }

      mockRunner.setTaskCompletionCallback((taskId: string) => {
        taskStore.update(taskId, {
          status: 'completed',
          resultStatus: 'completed',
          resultSummary: 'Updated MEMORY.md.',
          completedAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
        })
      })

      const scheduler = new MemoryConsolidationScheduler({
        db,
        agentCore: mockAgentCore as any,
        taskStore,
        taskRunner: mockRunner as any,
        getDefaultProvider: () => provider,
      })

      await scheduler.runNow()

      expect(mockAgentCore.refreshSystemPrompt).toHaveBeenCalledOnce()
    })

    it('deduplicates concurrent runNow calls', async () => {
      const taskStore = new TaskStore(db)
      const mockRunner = createMockTaskRunner()
      const provider = makeProvider()

      mockRunner.setTaskCompletionCallback((taskId: string) => {
        taskStore.update(taskId, {
          status: 'completed',
          resultStatus: 'silent',
          resultSummary: 'Done.',
          completedAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
        })
      })

      const scheduler = new MemoryConsolidationScheduler({
        db,
        taskStore,
        taskRunner: mockRunner as any,
        getDefaultProvider: () => provider,
      })

      // Call runNow twice concurrently
      const [result1, result2] = await Promise.all([
        scheduler.runNow(),
        scheduler.runNow(),
      ])

      // Should only start one task
      expect(mockRunner.startTask).toHaveBeenCalledOnce()
      expect(result1).toBe(result2) // Same promise
    })

    it('records lastRun and lastResult after execution', async () => {
      const taskStore = new TaskStore(db)
      const mockRunner = createMockTaskRunner()
      const provider = makeProvider()

      mockRunner.setTaskCompletionCallback((taskId: string) => {
        taskStore.update(taskId, {
          status: 'completed',
          resultStatus: 'silent',
          completedAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
        })
      })

      const scheduler = new MemoryConsolidationScheduler({
        db,
        taskStore,
        taskRunner: mockRunner as any,
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
      const mockRunner = createMockTaskRunner()
      const provider = makeProvider()

      mockRunner.setTaskCompletionCallback((taskId: string) => {
        taskStore.update(taskId, {
          status: 'completed',
          resultStatus: 'silent',
          completedAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
        })
      })

      const scheduler = new MemoryConsolidationScheduler({
        db,
        taskStore,
        taskRunner: mockRunner as any,
        getDefaultProvider: () => provider,
      })

      await scheduler.runNow()

      // Check that a tool_call was logged
      const rows = db.prepare(
        "SELECT * FROM tool_calls WHERE tool_name = 'memory_consolidation'"
      ).all() as any[]
      expect(rows.length).toBeGreaterThanOrEqual(1)
      expect(rows[0].session_id).toMatch(/^nightly-consolidation-/)
    })
  })

  describe('setters', () => {
    it('setAgentCore updates the agentCore reference', () => {
      const scheduler = new MemoryConsolidationScheduler({ db })
      const mockAgentCore = { refreshSystemPrompt: vi.fn() }
      scheduler.setAgentCore(mockAgentCore as any)
      // No error thrown
    })

    it('setTaskStore updates the taskStore reference', () => {
      const scheduler = new MemoryConsolidationScheduler({ db })
      const taskStore = new TaskStore(db)
      scheduler.setTaskStore(taskStore)
      // No error thrown
    })

    it('setTaskRunner updates the taskRunner reference', () => {
      const scheduler = new MemoryConsolidationScheduler({ db })
      const mockRunner = createMockTaskRunner()
      scheduler.setTaskRunner(mockRunner as any)
      // No error thrown
    })
  })
})
