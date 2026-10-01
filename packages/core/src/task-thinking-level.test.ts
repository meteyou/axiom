import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { initDatabase } from './database.js'
import type { Database } from './database.js'
import { TaskRunner } from './task-runner.js'
import type { TaskRunnerOptions } from './task-runner.js'
import { SessionManager } from './session-manager.js'
import { createTaskTool, formatThinkingLine, listTasksTool } from './task-tools.js'
import { createCronjobTool, editCronjobTool, getCronjobTool } from './cronjob-tools.js'
import { ScheduledTaskStore } from './scheduled-task-store.js'
import { TaskScheduler } from './task-scheduler.js'
import { assembleSystemPrompt } from './memory.js'
import type { ProviderConfig } from './provider-config.js'
import type { Task, CreateTaskInput, UpdateTaskInput, TaskListFilters } from './task-store.js'
import type { TaskRuntimeScheduleBoundary, TaskRuntimeTaskBoundary } from './task-runtime.js'

const agentInitialStates: Array<{ thinkingLevel?: string }> = []

vi.mock('./provider-config.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>
  return { ...original, estimateCost: vi.fn(() => 0.001) }
})

vi.mock('@earendil-works/pi-agent-core', () => {
  return {
    Agent: vi.fn().mockImplementation((options: { initialState?: { thinkingLevel?: string } }) => {
      agentInitialStates.push({ ...options.initialState })
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

const provider: ProviderConfig = {
  id: 'gateway-id',
  name: 'Custom Gateway',
  type: 'openai-completions',
  providerType: 'custom-openai-completions',
  provider: 'custom',
  baseUrl: 'https://llm.example.com/v1',
  apiKey: 'test-key',
  enabledModels: ['reasoner'],
  models: [],
  status: 'connected',
  authMethod: 'api-key',
}

// Supports off, low, high and max — medium/xhigh are clamped.
const reasoningModel = {
  reasoning: true,
  thinkingLevelMap: { minimal: null, medium: null, xhigh: null, max: 'max' },
} as unknown as ReturnType<TaskRunnerOptions['buildModel']>

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map(c => c.text ?? '').join('\n')
}

describe('task thinking level', () => {
  const tmpFiles: string[] = []
  let db: Database
  let runner: TaskRunner

  function tmpDbPath(): string {
    const p = path.join(os.tmpdir(), `axiom-task-thinking-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
    tmpFiles.push(p)
    return p
  }

  function taskBoundary(): TaskRuntimeTaskBoundary {
    const store = runner.getStore()
    return {
      create: (input: CreateTaskInput) => store.create(input),
      getById: (id: string) => store.getById(id),
      list: (filters?: TaskListFilters) => store.list(filters),
      update: (id: string, updates: UpdateTaskInput) => store.update(id, updates),
      start: (task: Task, p, overrides, parentSessionId) => runner.startTask(task, p, overrides, parentSessionId),
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

  function createTool() {
    return createTaskTool({
      taskRuntime: taskBoundary(),
      getDefaultProvider: () => provider,
      resolveProvider: () => provider,
      defaultMaxDurationMinutes: 60,
      maxDurationMinutesCap: 240,
    })
  }

  beforeEach(() => {
    agentInitialStates.length = 0
    db = initDatabase(tmpDbPath())
    runner = new TaskRunner({
      db,
      buildModel: () => reasoningModel,
      getApiKey: async () => 'test-key',
      tools: [],
      memoryDir: undefined,
      onTaskComplete: () => { },
      sessionManager: new SessionManager({ db }),
      backgroundThinkingLevel: 'low',
    })
  })

  afterEach(() => {
    for (const id of runner.getRunningTaskIds()) runner.abortTask(id, 'cleanup')
    runner.dispose()
    db.close()
    for (const f of tmpFiles) {
      try { fs.unlinkSync(f) } catch { /* ignore */ }
    }
    tmpFiles.length = 0
  })

  it('create_task runs with the requested level, clamped to the model', async () => {
    const result = await createTool().execute('call-1', { prompt: 'p', name: 'Hard', thinking_level: 'medium' })

    const taskId = (result.details as { taskId: string }).taskId
    const task = runner.getStore().getById(taskId)!
    expect(task.thinkingLevel).toBe('medium')
    expect(task.effectiveThinkingLevel).toBe('high')
    expect(agentInitialStates.at(-1)?.thinkingLevel).toBe('high')
    expect(textOf(result)).toContain('Thinking: medium → high (clamped to model)')
  })

  it('create_task without thinking_level uses the background default', async () => {
    const result = await createTool().execute('call-2', { prompt: 'p', name: 'Simple' })

    const task = runner.getStore().getById((result.details as { taskId: string }).taskId)!
    expect(task.thinkingLevel).toBeNull()
    expect(task.effectiveThinkingLevel).toBe('low')
    expect(agentInitialStates.at(-1)?.thinkingLevel).toBe('low')
    expect(textOf(result)).toContain('Thinking: low (default)')
  })

  it('create_task rejects an unknown thinking_level without creating a task', async () => {
    const result = await createTool().execute('call-3', { prompt: 'p', name: 'Bad', thinking_level: 'ultra' })

    expect(result.details).toMatchObject({ error: true })
    expect(textOf(result)).toContain('Invalid thinking_level "ultra"')
    expect(runner.getStore().list()).toHaveLength(0)
  })

  it('list_tasks shows the thinking level', async () => {
    await createTool().execute('call-4', { prompt: 'p', name: 'Max', thinking_level: 'MAX' })

    const result = await listTasksTool({ taskRuntime: taskBoundary() }).execute('call-5', {})
    expect(textOf(result)).toContain('Thinking: max')
  })

  it('recovery keeps the requested thinking level', async () => {
    const store = runner.getStore()
    const interrupted = store.create({ name: 'Interrupted', prompt: 'p', triggerType: 'agent', provider: provider.name, thinkingLevel: 'max' })

    await runner.recoverTasks(() => provider, provider)

    const resumed = store.list().find(t => t.id !== interrupted.id)!
    expect(resumed.thinkingLevel).toBe('max')
    expect(resumed.effectiveThinkingLevel).toBe('max')
  })

  it('a cronjob run passes its thinking level to the task', async () => {
    const taskRunner = { startTask: vi.fn().mockResolvedValue('task-id'), getStore: () => runner.getStore() } as unknown as TaskRunner
    const scheduler = new TaskScheduler({
      db,
      taskStore: runner.getStore(),
      taskRunner,
      getDefaultProvider: () => provider,
      resolveProvider: () => provider,
    })
    const scheduled = new ScheduledTaskStore(db).create({ name: 'Cron', prompt: 'p', schedule: '0 9 * * *', thinkingLevel: 'high' })

    const taskId = await scheduler.triggerNow(scheduled.id)
    scheduler.dispose()

    expect(runner.getStore().getById(taskId!)?.thinkingLevel).toBe('high')
  })
})

describe('cronjob tools thinking level', () => {
  let db: Database
  let dbPath: string
  let boundary: TaskRuntimeScheduleBoundary

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `axiom-cron-thinking-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
    db = initDatabase(dbPath)
    const store = new ScheduledTaskStore(db)
    boundary = {
      create: input => store.create(input),
      getById: id => store.getById(id),
      list: () => store.list(),
      listEnabled: () => store.listEnabled(),
      update: (id, updates) => store.update(id, updates),
      delete: id => store.delete(id),
      register: () => {},
      unregister: () => {},
      triggerNow: async () => null,
      getActiveSchedules: () => [],
      start: () => {},
      stop: () => {},
      restart: () => {},
    }
  })

  afterEach(() => {
    db.close()
    try { fs.unlinkSync(dbPath) } catch { /* ignore */ }
  })

  it('create, edit and reset the cronjob thinking level', async () => {
    const created = await createCronjobTool({ taskRuntime: boundary }).execute('c1', {
      name: 'Digest', prompt: 'p', schedule: '0 9 * * *', thinking_level: 'high',
    })
    const id = (created.details as { cronjobId: string }).cronjobId
    expect(boundary.getById(id)?.thinkingLevel).toBe('high')
    expect(textOf(created)).toContain('Thinking: high')

    const edit = editCronjobTool({ taskRuntime: boundary })
    await edit.execute('c2', { id, name: 'Digest 2' })
    expect(boundary.getById(id)?.thinkingLevel).toBe('high')

    await edit.execute('c3', { id, thinking_level: 'default' })
    expect(boundary.getById(id)?.thinkingLevel).toBeNull()

    const shown = await getCronjobTool({ taskRuntime: boundary }).execute('c4', { id })
    expect(textOf(shown)).toContain('Thinking: default')
  })

  it('rejects an unknown level and ignores the level for injections', async () => {
    const tool = createCronjobTool({ taskRuntime: boundary })
    const bad = await tool.execute('c5', { name: 'X', prompt: 'p', schedule: '0 9 * * *', thinking_level: 'turbo' })
    expect(bad.details).toMatchObject({ error: true })

    const injection = await tool.execute('c6', {
      name: 'Ping', prompt: 'Hello', schedule: '0 9 * * *', action_type: 'injection', thinking_level: 'high',
    })
    expect(boundary.getById((injection.details as { cronjobId: string }).cronjobId)?.thinkingLevel).toBeNull()
  })
})

describe('thinking level prompt + formatting', () => {
  it('lists supported levels per model and the default task level', () => {
    const prompt = assembleSystemPrompt({
      memoryDir: fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-thinking-prompt-')),
      availableProviders: [{
        name: 'Custom Gateway',
        models: [{ id: 'reasoner', isDefaultTaskModel: true, thinkingLevels: ['off', 'low', 'high', 'max'] }],
      }],
      defaultTaskThinkingLevel: 'low',
    })
    expect(prompt).toContain('- Custom Gateway — reasoner: default task model. thinking: off, low, high, max')
    expect(prompt).toContain('background thinking level (currently `low`)')
    expect(prompt).toContain('`thinking_level`')
  })

  it('formats requested vs. effective levels', () => {
    expect(formatThinkingLine(null, null)).toBe('Thinking: default')
    expect(formatThinkingLine('high', null)).toBe('Thinking: high')
    expect(formatThinkingLine(null, 'low')).toBe('Thinking: low (default)')
    expect(formatThinkingLine('high', 'high')).toBe('Thinking: high')
    expect(formatThinkingLine('medium', 'high')).toBe('Thinking: medium → high (clamped to model)')
  })
})
