import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { initDatabase } from './database.js'
import type { Database } from './database.js'
import { TaskRunner } from './task-runner.js'
import type { TaskRunnerOptions } from './task-runner.js'
import { SessionManager } from './session-manager.js'
import { createTaskReadTool, createTaskWriteTool } from './task-tools.js'
import type { ProviderConfig } from './provider-config.js'
import type { Task, CreateTaskInput, UpdateTaskInput, TaskListFilters } from './task-store.js'
import type { TaskRuntimeTaskBoundary } from './task-runtime.js'

vi.mock('./provider-config.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>
  return { ...original, estimateCost: vi.fn(() => 0.001) }
})

vi.mock('@earendil-works/pi-agent-core', () => {
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
  enabledModels: ['test-model'],
  models: [],
  status: 'connected',
  authMethod: 'api-key',
}

describe('task_write create', () => {
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
      try { fs.unlinkSync(f) } catch {
        // Cleanup failures should not mask the test result.
      }
    }
    tmpFiles.length = 0
  })

  it('persists max_duration_minutes from the tool input onto the Task row', async () => {
    const tool = createTaskWriteTool({
      taskRuntime: buildBoundary(),
      getDefaultProvider: () => mockProvider,
      resolveProvider: () => mockProvider,
      defaultMaxDurationMinutes: 60,
      maxDurationMinutesCap: 240,
    })

    const result = await tool.execute('call-1', {
      action: 'create',
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
    const tool = createTaskWriteTool({
      taskRuntime: buildBoundary(),
      getDefaultProvider: () => mockProvider,
      resolveProvider: () => mockProvider,
      defaultMaxDurationMinutes: 30,
      maxDurationMinutesCap: 240,
    })

    const result = await tool.execute('call-2', {
      action: 'create',
      prompt: 'do work',
      name: 'Default',
    })

    const taskId = (result.details as { taskId: string }).taskId
    const task = runner.getStore().getById(taskId)!
    expect(task.maxDurationMinutes).toBe(30)

    runner.abortTask(taskId, 'cleanup')
  })

  it('caps max_duration_minutes at maxDurationMinutesCap', async () => {
    const tool = createTaskWriteTool({
      taskRuntime: buildBoundary(),
      getDefaultProvider: () => mockProvider,
      resolveProvider: () => mockProvider,
      defaultMaxDurationMinutes: 30,
      maxDurationMinutesCap: 120,
    })

    const result = await tool.execute('call-3', {
      action: 'create',
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
    const tool = createTaskWriteTool({
      taskRuntime: buildBoundary(),
      getDefaultProvider: () => mockProvider,
      resolveProvider: () => mockProvider,
      defaultMaxDurationMinutes: 999,
      maxDurationMinutesCap: 9999,
    })

    const result = await tool.execute('call-4', {
      action: 'create',
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

  it('returns a tool error instead of creating a task when no default provider is configured', async () => {
    const tool = createTaskWriteTool({
      taskRuntime: buildBoundary(),
      getDefaultProvider: () => null,
      resolveProvider: () => mockProvider,
      defaultMaxDurationMinutes: 30,
      maxDurationMinutesCap: 120,
    })

    const result = await tool.execute('call-5', { action: 'create', prompt: 'do work', name: 'NoProvider' })

    expect(result.details).toMatchObject({ error: true })
    expect((result.content[0] as { type: 'text'; text: string }).text).toContain('No default task provider is configured')
    expect(runner.getStore().list().filter(t => t.name === 'NoProvider')).toHaveLength(0)
  })

  describe('attached_skills', () => {
    let skillsTmpDir: string
    let originalDataDir: string | undefined

    beforeEach(() => {
      originalDataDir = process.env.DATA_DIR
      skillsTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-task-tools-skills-'))
      process.env.DATA_DIR = skillsTmpDir

      const nitterDir = path.join(skillsTmpDir, 'skills_agent', 'nitter')
      fs.mkdirSync(nitterDir, { recursive: true })
      fs.writeFileSync(
        path.join(nitterDir, 'SKILL.md'),
        '---\nname: nitter\ndescription: Fetch tweets via Nitter.\n---\n\n# Nitter Skill\nAlways rotate Nitter mirrors.',
        'utf-8',
      )
    })

    afterEach(() => {
      if (originalDataDir === undefined) {
        delete process.env.DATA_DIR
      } else {
        process.env.DATA_DIR = originalDataDir
      }
      try { fs.rmSync(skillsTmpDir, { recursive: true, force: true }) } catch {
        // Cleanup failures should not mask the test result.
      }
    })

    async function runToolCapturingSystemPrompt(
      params: Record<string, unknown>,
    ): Promise<{ systemPrompt: string; details: Record<string, unknown> }> {
      const { Agent } = await import('@earendil-works/pi-agent-core')
      const MockAgent = Agent as unknown as ReturnType<typeof vi.fn>

      type Captured = { initialState: { systemPrompt: string } }
      const captured: { value: Captured | null } = { value: null }
      MockAgent.mockImplementationOnce((agentOptions: unknown) => {
        captured.value = agentOptions as Captured
        const messages: unknown[] = []
        return {
          subscribe: vi.fn(() => () => {}),
          prompt: vi.fn(async () => {
            messages.push({
              role: 'assistant',
              content: [{ type: 'text', text: 'STATUS: completed\nSUMMARY: ok' }],
            })
          }),
          abort: vi.fn(),
          state: { get messages() { return messages } },
        }
      })

      const tool = createTaskWriteTool({
        taskRuntime: buildBoundary(),
        getDefaultProvider: () => mockProvider,
        resolveProvider: () => mockProvider,
        defaultMaxDurationMinutes: 30,
        maxDurationMinutesCap: 120,
      })

      const result = await tool.execute('call-skills', { action: 'create', ...params })
      await new Promise(resolve => setTimeout(resolve, 50))

      if (!captured.value) throw new Error('Agent was not instantiated')
      return {
        systemPrompt: captured.value.initialState.systemPrompt,
        details: result.details as Record<string, unknown>,
      }
    }

    it('injects the SKILL.md content of attached skills into the task system prompt', async () => {
      const { systemPrompt, details } = await runToolCapturingSystemPrompt({
        prompt: 'do work',
        name: 'WithSkills',
        attached_skills: ['nitter'],
      })

      expect(systemPrompt.startsWith('<attached_skills>')).toBe(true)
      expect(systemPrompt).toContain('<skill name="nitter">')
      expect(systemPrompt).toContain('Always rotate Nitter mirrors.')
      expect(systemPrompt).toContain('do work')
      expect(details.attachedSkills).toEqual(['nitter'])
    })

    it('normalizes attached_skills (trim + dedupe + drop empty)', async () => {
      const { details } = await runToolCapturingSystemPrompt({
        prompt: 'do work',
        name: 'NormalizedSkills',
        attached_skills: ['nitter', '  nitter  ', ''],
      })

      expect(details.attachedSkills).toEqual(['nitter'])
    })

    it('skips a missing SKILL.md and still starts the task', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const { systemPrompt, details } = await runToolCapturingSystemPrompt({
          prompt: 'do work',
          name: 'MissingSkill',
          attached_skills: ['nitter', 'does-not-exist'],
        })

        expect(systemPrompt).toContain('<skill name="nitter">')
        expect(systemPrompt).not.toContain('<skill name="does-not-exist">')
        expect(details.error).not.toBe(true)
        const warned = warnSpy.mock.calls.some(args => String(args[0] ?? '').includes('does-not-exist'))
        expect(warned).toBe(true)
      } finally {
        warnSpy.mockRestore()
      }
    })

    it('adds no attached-skills block when the parameter is omitted', async () => {
      const { systemPrompt, details } = await runToolCapturingSystemPrompt({
        prompt: 'do work',
        name: 'NoSkills',
      })

      expect(systemPrompt).not.toContain('<attached_skills>')
      expect(details.attachedSkills).toBeNull()
    })
  })
})

describe('task_write validation', () => {
  function emptyRuntime(): TaskRuntimeTaskBoundary {
    return {
      create: vi.fn(),
      getById: vi.fn(() => null),
      list: vi.fn(() => []),
      update: vi.fn(),
      start: vi.fn(),
      resume: vi.fn(),
      abort: vi.fn(),
      isRunning: vi.fn(() => false),
      getRunningIds: vi.fn(() => []),
      isPaused: vi.fn(() => false),
      getPausedIds: vi.fn(() => []),
      cleanupStalePaused: vi.fn(),
      recover: vi.fn(),
    } as unknown as TaskRuntimeTaskBoundary
  }

  function tool(runtime = emptyRuntime()) {
    return createTaskWriteTool({
      taskRuntime: runtime,
      getDefaultProvider: () => mockProvider,
      resolveProvider: () => mockProvider,
      defaultMaxDurationMinutes: 30,
      maxDurationMinutesCap: 120,
    })
  }

  async function errorText(params: Record<string, unknown>, runtime = emptyRuntime()): Promise<string> {
    const result = await tool(runtime).execute('call', params)
    expect(result.details).toMatchObject({ error: true })
    return (result.content[0] as { type: 'text'; text: string }).text
  }

  it('exposes the create, resume and stop actions', () => {
    expect(tool().actions).toEqual(['create', 'resume', 'stop'])
  })

  it('reports missing fields per action', async () => {
    const runtime = emptyRuntime()
    expect(await errorText({ action: 'create', name: 'x' }, runtime)).toBe('Error: prompt is required for action=create.')
    expect(await errorText({ action: 'create' }, runtime)).toBe('Error: name, prompt are required for action=create.')
    expect(await errorText({ action: 'resume', task_id: 't1' }, runtime)).toBe('Error: message is required for action=resume.')
    expect(await errorText({ action: 'stop' }, runtime)).toBe('Error: task_id is required for action=stop.')
    expect(runtime.create).not.toHaveBeenCalled()
    expect(runtime.abort).not.toHaveBeenCalled()
  })

  it('rejects a missing or unknown action', async () => {
    expect(await errorText({ name: 'x', prompt: 'y' })).toContain('action is required for task_write. Valid actions: create, resume, stop.')
    expect(await errorText({ action: 'delete', task_id: 't1' })).toContain('Unknown action "delete"')
  })

  it('reports unknown task ids for resume and stop', async () => {
    expect(await errorText({ action: 'resume', task_id: 'nope', message: 'hi' })).toBe('Error: Task "nope" not found.')
    expect(await errorText({ action: 'stop', task_id: 'nope' })).toBe('Error: Task "nope" not found.')
  })
})

describe('task_read', () => {
  it('reports when there are no tasks', async () => {
    const taskRuntime = { list: vi.fn(() => []) } as unknown as TaskRuntimeTaskBoundary
    const result = await createTaskReadTool({ taskRuntime }).execute('call', { status: 'running' })
    expect((result.content[0] as { type: 'text'; text: string }).text).toBe('No tasks found matching filters: running.')
    expect(taskRuntime.list).toHaveBeenCalledWith(expect.objectContaining({ status: 'running', limit: 20 }))
  })
})
