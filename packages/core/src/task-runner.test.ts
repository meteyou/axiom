import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initDatabase } from './database.js'
import { TaskStore } from './task-store.js'
import { TaskRunner, formatTaskInjection } from './task-runner.js'
import type { TaskRunnerOptions, TaskOverrides } from './task-runner.js'
import type { Database } from './database.js'
import type { ProviderConfig } from './provider-config.js'
import { SessionManager } from './session-manager.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// Mock estimateCost to avoid needing a real model
vi.mock('./provider-config.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>
  return {
    ...original,
    estimateCost: vi.fn(() => 0.001),
  }
})

// Mock the PiAgent to avoid actual LLM calls
vi.mock('@mariozechner/pi-agent-core', () => {
  return {
    Agent: vi.fn().mockImplementation((_options: unknown) => {
      let subscribeFn: ((event: unknown) => void) | null = null
      const messages: unknown[] = []

      return {
        subscribe: vi.fn((fn: (event: unknown) => void) => {
          subscribeFn = fn
          return () => { subscribeFn = null }
        }),
        prompt: vi.fn(async () => {
          // Simulate a successful completion with assistant message
          if (subscribeFn) {
            subscribeFn({
              type: 'message_end',
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'STATUS: completed\nSUMMARY: Task done successfully' }],
                provider: 'test-provider',
                model: 'test-model',
                usage: {
                  input: 100,
                  output: 50,
                  cacheRead: 0,
                  cacheWrite: 0,
                  cost: { total: 0.001 },
                },
              },
            })
            subscribeFn({
              type: 'agent_end',
              messages: [],
            })
          }
          // Add message to state
          messages.push({
            role: 'assistant',
            content: [{ type: 'text', text: 'STATUS: completed\nSUMMARY: Task done successfully' }],
          })
        }),
        abort: vi.fn(),
        state: {
          get messages() { return messages },
        },
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

describe('TaskRunner', () => {
  let db: Database
  let store: TaskStore
  let runner: TaskRunner
  let sessionManager: SessionManager
  const tmpFiles: string[] = []
  let onTaskCompleteCalls: { taskId: string; injection: string }[] = []
  let onTaskPausedCalls: { taskId: string; injection: string }[] = []

  function tmpDbPath(): string {
    const p = path.join(os.tmpdir(), `openagent-runner-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
    tmpFiles.push(p)
    return p
  }

  beforeEach(() => {
    db = initDatabase(tmpDbPath())
    store = new TaskStore(db)
    sessionManager = new SessionManager({ db })
    onTaskCompleteCalls = []
    onTaskPausedCalls = []

    const options: TaskRunnerOptions = {
      db,
      buildModel: () => ({} as ReturnType<TaskRunnerOptions['buildModel']>),
      getApiKey: async () => 'test-key',
      tools: [],
      memoryDir: undefined,
      onTaskComplete: (taskId: string, injection: string) => {
        onTaskCompleteCalls.push({ taskId, injection })
      },
      onTaskPaused: (taskId: string, injection: string) => {
        onTaskPausedCalls.push({ taskId, injection })
      },
      sessionManager,
    }

    runner = new TaskRunner(options)
  })

  afterEach(() => {
    runner.dispose()
    db.close()
    for (const f of tmpFiles) {
      try { fs.unlinkSync(f) } catch { /* ignore */ }
    }
    tmpFiles.length = 0
  })

  describe('task lifecycle: create → run → complete', () => {
    it('starts a task and marks it as completed', async () => {
      const task = store.create({
        name: 'Test Task',
        prompt: 'Build something',
        triggerType: 'agent',
        sessionId: 'task-session-1',
      })

      await runner.startTask(task, mockProvider)

      // Wait for async processing
      await new Promise(resolve => setTimeout(resolve, 100))

      const updated = store.getById(task.id)!
      expect(updated.status).toBe('completed')
      expect(updated.resultStatus).toBe('completed')
      expect(updated.resultSummary).toBe('Task done successfully')
      expect(updated.startedAt).toBeTruthy()
      expect(updated.completedAt).toBeTruthy()
      expect(updated.provider).toBe('test-provider')
      expect(updated.model).toBe('test-model')
    })

    it('calls onTaskComplete with injection message', async () => {
      const task = store.create({
        name: 'Notify Task',
        prompt: 'Do work',
        triggerType: 'agent',
      })

      await runner.startTask(task, mockProvider)
      await new Promise(resolve => setTimeout(resolve, 100))

      expect(onTaskCompleteCalls).toHaveLength(1)
      expect(onTaskCompleteCalls[0].taskId).toBe(task.id)
      expect(onTaskCompleteCalls[0].injection).toContain('<task_injection')
      expect(onTaskCompleteCalls[0].injection).toContain('task_name="Notify Task"')
      expect(onTaskCompleteCalls[0].injection).toContain('status="completed"')
    })

    it('tracks token usage', async () => {
      const task = store.create({
        name: 'Token Task',
        prompt: 'Count tokens',
        triggerType: 'agent',
        sessionId: 'task-token-session',
      })

      await runner.startTask(task, mockProvider)
      await new Promise(resolve => setTimeout(resolve, 100))

      const updated = store.getById(task.id)!
      expect(updated.promptTokens).toBe(100)
      expect(updated.completionTokens).toBe(50)
      expect(updated.estimatedCost).toBeGreaterThan(0)

      // Check that token usage was logged to the token_usage table
      const tokenRows = db.prepare('SELECT * FROM token_usage WHERE session_id = ?').all('task-token-session') as Array<Record<string, unknown>>
      expect(tokenRows.length).toBeGreaterThan(0)
      expect(tokenRows[0].prompt_tokens).toBe(100)
      expect(tokenRows[0].completion_tokens).toBe(50)
    })
  })

  describe('task lifecycle: create → run → fail', () => {
    it('marks task as failed when agent throws', async () => {
      // Override mock to throw
      const { Agent } = await import('@mariozechner/pi-agent-core')
      const MockAgent = Agent as unknown as ReturnType<typeof vi.fn>
      MockAgent.mockImplementationOnce(() => {
        return {
          subscribe: vi.fn(() => () => {}),
          prompt: vi.fn(async () => {
            throw new Error('LLM API error')
          }),
          abort: vi.fn(),
          state: { messages: [] },
        }
      })

      const task = store.create({
        name: 'Fail Task',
        prompt: 'This will fail',
        triggerType: 'agent',
      })

      await runner.startTask(task, mockProvider)
      await new Promise(resolve => setTimeout(resolve, 100))

      const updated = store.getById(task.id)!
      expect(updated.status).toBe('failed')
      expect(updated.resultStatus).toBe('failed')
      expect(updated.errorMessage).toBe('LLM API error')
      expect(updated.completedAt).toBeTruthy()

      // Should still call onTaskComplete
      expect(onTaskCompleteCalls).toHaveLength(1)
      expect(onTaskCompleteCalls[0].injection).toContain('status="failed"')
    })
  })

  describe('max duration timeout', () => {
    it('aborts task via abortTask method', async () => {
      const { Agent } = await import('@mariozechner/pi-agent-core')
      const MockAgent = Agent as unknown as ReturnType<typeof vi.fn>

      let resolvePrompt: (() => void) | null = null
      let abortCalled = false
      MockAgent.mockImplementationOnce(() => {
        return {
          subscribe: vi.fn(() => () => {}),
          prompt: vi.fn(() => new Promise<void>((resolve) => {
            resolvePrompt = resolve
          })),
          abort: vi.fn(() => {
            abortCalled = true
            // When abort is called, resolve the promise so runTaskAsync catches the error
            if (resolvePrompt) resolvePrompt()
          }),
          state: { messages: [] },
        }
      })

      const task = store.create({
        name: 'Timeout Task',
        prompt: 'Long running task',
        triggerType: 'agent',
      })

      await runner.startTask(task, mockProvider)

      // Task should be running (prompt is blocked)
      expect(runner.isRunning(task.id)).toBe(true)

      // Abort it (simulates what timeout would do)
      runner.abortTask(task.id, 'Max duration exceeded')

      // abortTask updates the DB synchronously
      const updated = store.getById(task.id)!
      expect(updated.status).toBe('failed')
      expect(updated.errorMessage).toBe('Max duration exceeded')
      expect(runner.isRunning(task.id)).toBe(false)
      expect(abortCalled).toBe(true)
    })
  })

  describe('formatTaskInjection', () => {
    it('formats a completed task injection correctly', () => {
      const task = store.create({
        name: 'Format Test',
        prompt: 'test',
        triggerType: 'agent',
      })
      store.update(task.id, {
        resultStatus: 'completed',
        resultSummary: 'Built the app successfully',
        promptTokens: 5000,
        completionTokens: 2000,
      })

      const updated = store.getById(task.id)!
      const injection = formatTaskInjection(updated, 5)

      expect(injection).toContain(`task_id="${task.id}"`)
      expect(injection).toContain('task_name="Format Test"')
      expect(injection).toContain('status="completed"')
      expect(injection).toContain('trigger="agent"')
      expect(injection).toContain('duration_minutes="5"')
      expect(injection).toContain('tokens_used="7000"')
      expect(injection).toContain('Built the app successfully')
    })

    it('formats a failed task injection correctly', () => {
      const task = store.create({
        name: 'Failed Task',
        prompt: 'test',
        triggerType: 'user',
      })
      store.update(task.id, {
        status: 'failed',
        resultStatus: 'failed',
        errorMessage: 'API rate limit hit',
      })

      const updated = store.getById(task.id)!
      const injection = formatTaskInjection(updated, 2)

      expect(injection).toContain('status="failed"')
      expect(injection).toContain('trigger="user"')
      expect(injection).toContain('API rate limit hit')
    })
  })

  describe('getRunningTaskIds', () => {
    it('tracks running tasks', async () => {
      const { Agent } = await import('@mariozechner/pi-agent-core')
      const MockAgent = Agent as unknown as ReturnType<typeof vi.fn>

      let resolvePrompt: (() => void) | null = null
      MockAgent.mockImplementationOnce(() => {
        return {
          subscribe: vi.fn(() => () => {}),
          prompt: vi.fn(() => new Promise<void>((resolve) => {
            resolvePrompt = resolve
          })),
          abort: vi.fn(() => { if (resolvePrompt) resolvePrompt() }),
          state: { messages: [] },
        }
      })

      const task = store.create({
        name: 'Running Task',
        prompt: 'work',
        triggerType: 'agent',
      })

      await runner.startTask(task, mockProvider)

      expect(runner.getRunningTaskIds()).toContain(task.id)
      expect(runner.isRunning(task.id)).toBe(true)

      runner.abortTask(task.id)
      await new Promise(resolve => setTimeout(resolve, 50))

      expect(runner.isRunning(task.id)).toBe(false)
    })
  })

  describe('pause/resume lifecycle', () => {
    it('pauses a task when agent outputs STATUS: question', async () => {
      const { Agent } = await import('@mariozechner/pi-agent-core')
      const MockAgent = Agent as unknown as ReturnType<typeof vi.fn>

      MockAgent.mockImplementationOnce(() => {
        const messages: unknown[] = []
        return {
          subscribe: vi.fn(() => () => {}),
          prompt: vi.fn(async () => {
            messages.push({
              role: 'assistant',
              content: [{ type: 'text', text: 'STATUS: question\nSUMMARY: What database should I use? PostgreSQL or MySQL?' }],
            })
          }),
          abort: vi.fn(),
          state: { get messages() { return messages } },
        }
      })

      const task = store.create({
        name: 'Question Task',
        prompt: 'Build a web app',
        triggerType: 'agent',
      })

      await runner.startTask(task, mockProvider)
      await new Promise(resolve => setTimeout(resolve, 100))

      const updated = store.getById(task.id)!
      expect(updated.status).toBe('paused')
      expect(updated.resultStatus).toBe('question')
      expect(updated.resultSummary).toContain('What database should I use?')
      expect(updated.completedAt).toBeNull()

      // Task should be in paused map, not running
      expect(runner.isRunning(task.id)).toBe(false)
      expect(runner.isPaused(task.id)).toBe(true)
      expect(runner.getPausedTaskIds()).toContain(task.id)

      // onTaskPaused should have been called
      expect(onTaskPausedCalls).toHaveLength(1)
      expect(onTaskPausedCalls[0].taskId).toBe(task.id)
      expect(onTaskPausedCalls[0].injection).toContain('status="question"')
      expect(onTaskPausedCalls[0].injection).toContain('What database should I use?')

      // onTaskComplete should NOT have been called
      expect(onTaskCompleteCalls).toHaveLength(0)
    })

    it('resumes a paused task and completes', async () => {
      const { Agent } = await import('@mariozechner/pi-agent-core')
      const MockAgent = Agent as unknown as ReturnType<typeof vi.fn>

      let promptCount = 0
      const messages: unknown[] = []
      MockAgent.mockImplementationOnce(() => {
        return {
          subscribe: vi.fn(() => () => {}),
          prompt: vi.fn(async () => {
            promptCount++
            if (promptCount === 1) {
              // First prompt: ask a question
              messages.push({
                role: 'assistant',
                content: [{ type: 'text', text: 'STATUS: question\nSUMMARY: Which framework should I use?' }],
              })
            } else {
              // Second prompt (resume): complete the task
              messages.push({
                role: 'assistant',
                content: [{ type: 'text', text: 'STATUS: completed\nSUMMARY: Built the app using React as requested.' }],
              })
            }
          }),
          abort: vi.fn(),
          state: { get messages() { return messages } },
        }
      })

      const task = store.create({
        name: 'Resume Task',
        prompt: 'Build a web app',
        triggerType: 'agent',
      })

      // Start → pauses with question
      await runner.startTask(task, mockProvider)
      await new Promise(resolve => setTimeout(resolve, 100))

      expect(runner.isPaused(task.id)).toBe(true)
      expect(store.getById(task.id)!.status).toBe('paused')

      // Resume with answer
      const resumed = await runner.resumeTask(task.id, 'Use React please')
      expect(resumed).toBe(true)

      await new Promise(resolve => setTimeout(resolve, 100))

      // Task should be completed
      const updated = store.getById(task.id)!
      expect(updated.status).toBe('completed')
      expect(updated.resultStatus).toBe('completed')
      expect(updated.resultSummary).toContain('Built the app using React')
      expect(updated.completedAt).toBeTruthy()

      // Should not be in paused or running maps
      expect(runner.isPaused(task.id)).toBe(false)
      expect(runner.isRunning(task.id)).toBe(false)

      // onTaskComplete should have been called
      expect(onTaskCompleteCalls).toHaveLength(1)
      expect(onTaskCompleteCalls[0].injection).toContain('status="completed"')
    })

    it('status transitions: running → paused → running → completed', async () => {
      const { Agent } = await import('@mariozechner/pi-agent-core')
      const MockAgent = Agent as unknown as ReturnType<typeof vi.fn>

      let promptCount = 0
      const messages: unknown[] = []
      MockAgent.mockImplementationOnce(() => {
        return {
          subscribe: vi.fn(() => () => {}),
          prompt: vi.fn(async () => {
            promptCount++
            if (promptCount === 1) {
              messages.push({
                role: 'assistant',
                content: [{ type: 'text', text: 'STATUS: question\nSUMMARY: Need clarification' }],
              })
            } else {
              messages.push({
                role: 'assistant',
                content: [{ type: 'text', text: 'STATUS: completed\nSUMMARY: Done' }],
              })
            }
          }),
          abort: vi.fn(),
          state: { get messages() { return messages } },
        }
      })

      const task = store.create({
        name: 'Transition Task',
        prompt: 'Do work',
        triggerType: 'agent',
      })

      // running
      expect(store.getById(task.id)!.status).toBe('running')

      await runner.startTask(task, mockProvider)
      await new Promise(resolve => setTimeout(resolve, 100))

      // paused
      expect(store.getById(task.id)!.status).toBe('paused')

      await runner.resumeTask(task.id, 'Clarification provided')
      await new Promise(resolve => setTimeout(resolve, 100))

      // completed
      expect(store.getById(task.id)!.status).toBe('completed')
    })

    it('returns false when resuming a non-paused task', async () => {
      const result = await runner.resumeTask('non-existent-id', 'hello')
      expect(result).toBe(false)
    })
  })

  describe('24h cleanup of stale paused tasks', () => {
    it('cleans up tasks paused for >24h', async () => {
      const { Agent } = await import('@mariozechner/pi-agent-core')
      const MockAgent = Agent as unknown as ReturnType<typeof vi.fn>

      MockAgent.mockImplementationOnce(() => {
        const messages: unknown[] = []
        return {
          subscribe: vi.fn(() => () => {}),
          prompt: vi.fn(async () => {
            messages.push({
              role: 'assistant',
              content: [{ type: 'text', text: 'STATUS: question\nSUMMARY: What should I do?' }],
            })
          }),
          abort: vi.fn(),
          state: { get messages() { return messages } },
        }
      })

      const task = store.create({
        name: 'Stale Task',
        prompt: 'Do something',
        triggerType: 'agent',
      })

      await runner.startTask(task, mockProvider)
      await new Promise(resolve => setTimeout(resolve, 100))

      expect(runner.isPaused(task.id)).toBe(true)

      // Manually set pausedAt to >24h ago by accessing private field
      const pausedTasks = (runner as unknown as { pausedTasks: Map<string, { pausedAt: number }> }).pausedTasks
      const pausedTask = pausedTasks.get(task.id)!
      pausedTask.pausedAt = Date.now() - (25 * 60 * 60 * 1000) // 25 hours ago

      // Run cleanup
      const cleaned = runner.cleanupStalePausedTasks()
      expect(cleaned).toBe(1)

      // Task should be removed from memory
      expect(runner.isPaused(task.id)).toBe(false)

      // Task should be marked as failed in DB
      const updated = store.getById(task.id)!
      expect(updated.status).toBe('failed')
      expect(updated.resultStatus).toBe('failed')
      expect(updated.errorMessage).toBe('timeout — no response received')
      expect(updated.completedAt).toBeTruthy()

      // onTaskComplete should have been called for the timed-out task
      expect(onTaskCompleteCalls).toHaveLength(1)
    })

    it('does not clean up tasks paused for <24h', async () => {
      const { Agent } = await import('@mariozechner/pi-agent-core')
      const MockAgent = Agent as unknown as ReturnType<typeof vi.fn>

      MockAgent.mockImplementationOnce(() => {
        const messages: unknown[] = []
        return {
          subscribe: vi.fn(() => () => {}),
          prompt: vi.fn(async () => {
            messages.push({
              role: 'assistant',
              content: [{ type: 'text', text: 'STATUS: question\nSUMMARY: What should I do?' }],
            })
          }),
          abort: vi.fn(),
          state: { get messages() { return messages } },
        }
      })

      const task = store.create({
        name: 'Fresh Task',
        prompt: 'Do something',
        triggerType: 'agent',
      })

      await runner.startTask(task, mockProvider)
      await new Promise(resolve => setTimeout(resolve, 100))

      expect(runner.isPaused(task.id)).toBe(true)

      // Run cleanup — task is freshly paused, should not be cleaned
      const cleaned = runner.cleanupStalePausedTasks()
      expect(cleaned).toBe(0)
      expect(runner.isPaused(task.id)).toBe(true)
      expect(store.getById(task.id)!.status).toBe('paused')
    })
  })

  describe('server restart recovery', () => {
    it('marks paused tasks as failed on recovery', async () => {
      // Manually insert a paused task in DB (simulating a task left from a previous server session)
      const task = store.create({
        name: 'Paused Before Restart',
        prompt: 'Build something',
        triggerType: 'agent',
      })
      store.update(task.id, { status: 'paused', resultStatus: 'question', resultSummary: 'Which DB?' })

      const result = await runner.recoverTasks(
        () => mockProvider,
        mockProvider,
      )

      expect(result.failed).toBe(1)
      const updated = store.getById(task.id)!
      expect(updated.status).toBe('failed')
      expect(updated.errorMessage).toBe('server restart')
      expect(updated.resultSummary).toContain('server restart')
    })

    it('resumes running tasks on recovery', async () => {
      // Manually insert a running task in DB
      const task = store.create({
        name: 'Running Before Restart',
        prompt: 'Build an app',
        triggerType: 'agent',
        sessionId: 'session-restart-test',
      })
      store.update(task.id, { status: 'running', provider: 'test-provider', model: 'test-model' })

      // Add some tool calls for the session
      db.prepare(
        "INSERT INTO tool_calls (session_id, tool_name, input, output, duration_ms, status) VALUES (?, ?, ?, ?, ?, 'success')"
      ).run('session-restart-test', 'read_file', '{"path":"index.ts"}', '"file contents"', 100)

      const result = await runner.recoverTasks(
        (name) => name === 'test-provider' ? mockProvider : null,
        mockProvider,
      )

      expect(result.resumed).toBe(1)

      // Original task should be marked as failed
      const original = store.getById(task.id)!
      expect(original.status).toBe('failed')
      expect(original.errorMessage).toBe('server restart')

      // A new resumed task should have been created
      const allTasks = store.list()
      const resumedTask = allTasks.find(t => t.name === 'Running Before Restart (resumed)')
      expect(resumedTask).toBeDefined()
      expect(resumedTask!.prompt).toContain('Build an app')
      expect(resumedTask!.prompt).toContain('server restart')
    })

    it('handles recovery with no orphaned tasks', async () => {
      const result = await runner.recoverTasks(
        () => mockProvider,
        mockProvider,
      )

      expect(result.resumed).toBe(0)
      expect(result.failed).toBe(0)
    })

    it('marks running task as failed when provider is not found and resume fails', async () => {
      const { Agent } = await import('@mariozechner/pi-agent-core')
      const MockAgent = Agent as unknown as ReturnType<typeof vi.fn>

      MockAgent.mockImplementationOnce(() => {
        return {
          subscribe: vi.fn(() => () => {}),
          prompt: vi.fn(async () => {
            throw new Error('Cannot connect')
          }),
          abort: vi.fn(),
          state: { messages: [] },
        }
      })

      const task = store.create({
        name: 'Unreachable Task',
        prompt: 'Work',
        triggerType: 'agent',
      })
      store.update(task.id, { status: 'running', provider: 'unknown-provider', model: 'model' })

      await runner.recoverTasks(
        () => null,
        mockProvider,
      )

      // Should attempt to resume with default provider but the mock throws
      // Wait for async task to complete
      await new Promise(resolve => setTimeout(resolve, 200))

      // Original task should be marked as failed (server restart)
      const original = store.getById(task.id)!
      expect(original.status).toBe('failed')
    })
  })

  describe('task overrides', () => {
    it('excludes tools listed in toolsOverride', async () => {
      const { Agent } = await import('@mariozechner/pi-agent-core')
      const MockAgent = Agent as unknown as ReturnType<typeof vi.fn>

      let capturedOptions: { initialState: { tools: Array<{ name: string }>; systemPrompt: string } } | null = null
      const messages: unknown[] = []
      MockAgent.mockImplementationOnce((options: unknown) => {
        capturedOptions = options as typeof capturedOptions
        return {
          subscribe: vi.fn(() => () => {}),
          prompt: vi.fn(async () => {
            messages.push({
              role: 'assistant',
              content: [{ type: 'text', text: 'STATUS: completed\nSUMMARY: Done' }],
            })
          }),
          abort: vi.fn(),
          state: { get messages() { return messages } },
        }
      })

      // Recreate runner with named tools
      const toolA = { name: 'shell', description: 'Shell', parameters: {}, execute: async () => '' }
      const toolB = { name: 'read_file', description: 'Read', parameters: {}, execute: async () => '' }
      const toolC = { name: 'write_file', description: 'Write', parameters: {}, execute: async () => '' }

      const runnerWithTools = new TaskRunner({
        db,
        buildModel: () => ({} as ReturnType<TaskRunnerOptions['buildModel']>),
        getApiKey: async () => 'test-key',
        tools: [toolA, toolB, toolC] as unknown as TaskRunnerOptions['tools'],
        onTaskComplete: () => {},
        sessionManager,
      })

      const task = store.create({
        name: 'Tool Override Task',
        prompt: 'Do work',
        triggerType: 'cronjob',
      })

      const overrides: TaskOverrides = {
        toolsOverride: JSON.stringify(['shell', 'write_file']),
      }

      await runnerWithTools.startTask(task, mockProvider, overrides)
      await new Promise(resolve => setTimeout(resolve, 100))

      // The PiAgent should have been created with only read_file
      expect(capturedOptions).toBeTruthy()
      const passedTools = capturedOptions.initialState.tools
      expect(passedTools).toHaveLength(1)
      expect(passedTools[0].name).toBe('read_file')

      runnerWithTools.dispose()
    })

    it('excludes skills listed in skillsOverride (passed through to runner)', async () => {
      // Skills override is stored and passed through — the runner stores the override
      // and it's available for the system prompt builder to use.
      // For now we verify the override is accepted without error.
      const task = store.create({
        name: 'Skill Override Task',
        prompt: 'Do work',
        triggerType: 'cronjob',
      })

      const overrides: TaskOverrides = {
        skillsOverride: JSON.stringify(['brave-search', 'web-browser']),
      }

      await runner.startTask(task, mockProvider, overrides)
      await new Promise(resolve => setTimeout(resolve, 100))

      const updated = store.getById(task.id)!
      expect(updated.status).toBe('completed')
    })

    it('uses system prompt override when set', async () => {
      const { Agent } = await import('@mariozechner/pi-agent-core')
      const MockAgent = Agent as unknown as ReturnType<typeof vi.fn>

      let capturedOptions: { initialState: { tools: Array<{ name: string }>; systemPrompt: string } } | null = null
      const messages: unknown[] = []
      MockAgent.mockImplementationOnce((options: unknown) => {
        capturedOptions = options as typeof capturedOptions
        return {
          subscribe: vi.fn(() => () => {}),
          prompt: vi.fn(async () => {
            messages.push({
              role: 'assistant',
              content: [{ type: 'text', text: 'STATUS: completed\nSUMMARY: Done with custom prompt' }],
            })
          }),
          abort: vi.fn(),
          state: { get messages() { return messages } },
        }
      })

      const task = store.create({
        name: 'Custom Prompt Task',
        prompt: 'Do work',
        triggerType: 'cronjob',
      })

      const customPrompt = 'You are a specialized news summarizer. Only summarize tech news.'
      const overrides: TaskOverrides = {
        systemPromptOverride: customPrompt,
      }

      await runner.startTask(task, mockProvider, overrides)
      await new Promise(resolve => setTimeout(resolve, 100))

      // The PiAgent should have been created with the custom system prompt
      expect(capturedOptions).toBeTruthy()
      expect(capturedOptions.initialState.systemPrompt).toBe(customPrompt)

      const updated = store.getById(task.id)!
      expect(updated.status).toBe('completed')
      expect(updated.resultSummary).toBe('Done with custom prompt')
    })

    it('uses default system prompt when systemPromptOverride is null', async () => {
      const { Agent } = await import('@mariozechner/pi-agent-core')
      const MockAgent = Agent as unknown as ReturnType<typeof vi.fn>

      let capturedOptions: { initialState: { tools: Array<{ name: string }>; systemPrompt: string } } | null = null
      const messages: unknown[] = []
      MockAgent.mockImplementationOnce((options: unknown) => {
        capturedOptions = options as typeof capturedOptions
        return {
          subscribe: vi.fn(() => () => {}),
          prompt: vi.fn(async () => {
            messages.push({
              role: 'assistant',
              content: [{ type: 'text', text: 'STATUS: completed\nSUMMARY: Done' }],
            })
          }),
          abort: vi.fn(),
          state: { get messages() { return messages } },
        }
      })

      const task = store.create({
        name: 'Default Prompt Task',
        prompt: 'Do work',
        triggerType: 'cronjob',
      })

      const overrides: TaskOverrides = {
        systemPromptOverride: null,
      }

      await runner.startTask(task, mockProvider, overrides)
      await new Promise(resolve => setTimeout(resolve, 100))

      // Should use default prompt (contains "background task agent")
      expect(capturedOptions.initialState.systemPrompt).toContain('background task agent')
      expect(capturedOptions.initialState.systemPrompt).toContain('Do work')
    })

    it('handles invalid toolsOverride JSON gracefully', async () => {
      const task = store.create({
        name: 'Bad JSON Task',
        prompt: 'Do work',
        triggerType: 'cronjob',
      })

      const overrides: TaskOverrides = {
        toolsOverride: 'invalid-json',
      }

      // Should not throw, should use all tools
      await runner.startTask(task, mockProvider, overrides)
      await new Promise(resolve => setTimeout(resolve, 100))

      const updated = store.getById(task.id)!
      expect(updated.status).toBe('completed')
    })
  })
})
