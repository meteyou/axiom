import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { initDatabase } from './database.js'
import type { Database } from './database.js'
import { TaskRunner } from './task-runner.js'
import type { TaskRunnerOptions } from './task-runner.js'
import { SessionManager } from './session-manager.js'
import { createTaskTool } from './task-tools.js'
import type { ProviderConfig } from './provider-config.js'
import type { Task, CreateTaskInput, UpdateTaskInput, TaskListFilters } from './task-store.js'
import type { TaskRuntimeTaskBoundary } from './task-runtime.js'

vi.mock('./provider-config.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>
  return { ...original, estimateCost: vi.fn(() => 0.001) }
})

vi.mock('@mariozechner/pi-agent-core', () => {
  return {
    Agent: vi.fn().mockImplementation((_options: unknown) => {
      const messages: unknown[] = []
      return {
        subscribe: vi.fn(() => () => {}),
        prompt: vi.fn(() => new Promise<void>(() => { })),
        abort: vi.fn(),
        state: { get messages() { return messages } },
      }
    }),
  }
})

const mockProvider: ProviderConfig = {
  id: 'test-provider-id',
  name: 'test-provider',
  type: 'openai',
  providerType: 'openai',
  provider: 'openai',
  baseUrl: 'http://localhost:1234',
  apiKey: 'test-key',
  defaultModel: 'test-model',
  models: [],
  status: 'connected',
  authMethod: 'api-key',
}

describe('createTaskTool', () => {
  const tmpFiles: string[] = []
  let db: Database
  let runner: TaskRunner
  let sessionManager: SessionManager

  function tmpDbPath(): string {
    const p = path.join(os.tmpdir(), `axiom-task-tools-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
    tmpFiles.push(p)
    return p
  }

  function buildBoundary(): TaskRuntimeTaskBoundary {
    const store = runner.getStore()
    return {
      create: (input: CreateTaskInput) => store.create(input),
      getById: (id: string) => store.getById(id),
      list: (filters?: TaskListFilters) => store.list(filters),
      update: (id: string, updates: UpdateTaskInput) => store.update(id, updates),
      start: (task: Task, provider, overrides, parentSessionId) =>
        runner.startTask(task, provider, overrides, parentSessionId),
      resume: (taskId: string, message: string) => runner.resumeTask(taskId, message),
      abort: (taskId: string, reason?: string) => runner.abortTask(taskId, reason),
      isRunning: (taskId: string) => runner.isRunning(taskId),
      getRunningIds: () => runner.getRunningTaskIds(),
      isPaused: (taskId: string) => runner.isPaused(taskId),
      getPausedIds: () => runner.getPausedTaskIds(),
      cleanupStalePaused: () => runner.cleanupStalePausedTasks(),
      recover: (getProvider, defaultProvider) => runner.recoverTasks(getProvider, defaultProvider),
    }
  }

  beforeEach(() => {
    db = initDatabase(tmpDbPath())
    sessionManager = new SessionManager({ db })

    const options: TaskRunnerOptions = {
      db,
      buildModel: () => ({} as ReturnType<TaskRunnerOptions['buildModel']>),
      getApiKey: async () => 'test-key',
      tools: [],
      memoryDir: undefined,
      onTaskComplete: () => { },
      sessionManager,
    }
    runner = new TaskRunner(options)
  })

  afterEach(() => {
    runner.dispose()
    db.close()
    for (const f of tmpFiles) {
      try { fs.unlinkSync(f) } catch { }
    }
    tmpFiles.length = 0
  })

  it('persists max_duration_minutes from the tool input onto the Task row', async () => {
    const tool = createTaskTool({
      taskRuntime: buildBoundary(),
      getDefaultProvider: () => mockProvider,
      resolveProvider: () => mockProvider,
      defaultMaxDurationMinutes: 60,
      maxDurationMinutesCap: 240,
    })

    const result = await tool.execute('call-1', {
      prompt: 'do work',
      name: 'Test',
      max_duration_minutes: 5,
    })

    const taskId = (result.details as { taskId: string }).taskId
    const task = runner.getStore().getById(taskId)!
    expect(task.maxDurationMinutes).toBe(5)
    const first = result.content[0]
    expect(first.type).toBe('text')
    expect((first as { type: 'text'; text: string }).text).toContain('Max Duration: 5 minutes')

    runner.abortTask(taskId, 'cleanup')
  })

  it('falls back to defaultMaxDurationMinutes when the caller omits max_duration_minutes', async () => {
    const tool = createTaskTool({
      taskRuntime: buildBoundary(),
      getDefaultProvider: () => mockProvider,
      resolveProvider: () => mockProvider,
      defaultMaxDurationMinutes: 30,
      maxDurationMinutesCap: 240,
    })

    const result = await tool.execute('call-2', {
      prompt: 'do work',
      name: 'Default',
    })

    const taskId = (result.details as { taskId: string }).taskId
    const task = runner.getStore().getById(taskId)!
    expect(task.maxDurationMinutes).toBe(30)

    runner.abortTask(taskId, 'cleanup')
  })

  it('caps max_duration_minutes at maxDurationMinutesCap', async () => {
    const tool = createTaskTool({
      taskRuntime: buildBoundary(),
      getDefaultProvider: () => mockProvider,
      resolveProvider: () => mockProvider,
      defaultMaxDurationMinutes: 30,
      maxDurationMinutesCap: 120,
    })

    const result = await tool.execute('call-3', {
      prompt: 'do work',
      name: 'Capped',
      max_duration_minutes: 9999,
    })

    const taskId = (result.details as { taskId: string }).taskId
    const task = runner.getStore().getById(taskId)!
    expect(task.maxDurationMinutes).toBe(120)

    runner.abortTask(taskId, 'cleanup')
  })

  it('the TaskRunner timeout uses the tool-supplied max_duration_minutes', async () => {
    const tool = createTaskTool({
      taskRuntime: buildBoundary(),
      getDefaultProvider: () => mockProvider,
      resolveProvider: () => mockProvider,
      defaultMaxDurationMinutes: 999,
      maxDurationMinutesCap: 9999,
    })

    const result = await tool.execute('call-4', {
      prompt: 'do work',
      name: 'BudgetCheck',
      max_duration_minutes: 1,
    })
    const taskId = (result.details as { taskId: string }).taskId

    const longAgo = new Date(Date.now() - 2 * 60 * 1000)
      .toISOString().replace('T', ' ').slice(0, 19)
    runner.getStore().update(taskId, { startedAt: longAgo })

    const internal = runner as unknown as {
      scheduleMaxDurationTimeout: (rt: { taskId: string; timeoutTimer: unknown; startedAtMs: number }, t: { id: string; maxDurationMinutes: number | null; startedAt: string | null }) => void
      runningTasks: Map<string, { taskId: string; timeoutTimer: unknown; startedAtMs: number }>
    }
    const rt = internal.runningTasks.get(taskId)!
    const refreshed = runner.getStore().getById(taskId)!
    internal.scheduleMaxDurationTimeout(rt, refreshed)

    const updated = runner.getStore().getById(taskId)!
    expect(updated.status).toBe('failed')
    expect(updated.errorMessage).toBe('Max duration exceeded')
  })
})
