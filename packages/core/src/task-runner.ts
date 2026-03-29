import { randomUUID } from 'node:crypto'
import { Agent as PiAgent } from '@mariozechner/pi-agent-core'
import type { AgentEvent, AgentTool } from '@mariozechner/pi-agent-core'
import type { AssistantMessage, Message, Model, Api } from '@mariozechner/pi-ai'
import type { Database } from './database.js'
import { TaskStore } from './task-store.js'
import type { Task, TaskResultStatus } from './task-store.js'
import { logTokenUsage, logToolCall } from './token-logger.js'
import { estimateCost } from './provider-config.js'
import type { ProviderConfig } from './provider-config.js'

export interface TaskRunnerOptions {
  db: Database
  /** Function to build a Model from a provider config */
  buildModel: (provider: ProviderConfig) => Model<Api>
  /** Function to get API key for a provider */
  getApiKey: (provider: ProviderConfig) => Promise<string>
  /** Tools to give to each task agent */
  tools: AgentTool[]
  /** Memory directory reference for task agent system prompt */
  memoryDir?: string
  /** Callback when a task completes/fails — delivers the injection message */
  onTaskComplete: (taskId: string, injection: string) => void
}

interface RunningTask {
  taskId: string
  agent: PiAgent
  abortController: AbortController
  timeoutTimer: ReturnType<typeof setTimeout> | null
  promptTokens: number
  completionTokens: number
  estimatedCost: number
  toolCallCount: number
  toolCallTimers: Map<string, number>
  toolCallArgs: Map<string, unknown>
}

/**
 * Build the system prompt for a task agent
 */
function buildTaskSystemPrompt(taskPrompt: string, memoryDir?: string): string {
  const sections: string[] = []

  sections.push(`You are a background task agent. You are NOT a chatbot — you are an autonomous worker.

Your task: ${taskPrompt}

Guidelines:
- Work independently for as long as possible
- Do not ask unnecessary questions — make reasonable decisions yourself
- Only pause with a question if you truly cannot proceed without user input
- When finished, provide a concise but complete summary of what you did
- Include: what was accomplished, key decisions made, files created/modified, and any important notes`)

  if (memoryDir) {
    sections.push(`<memory_reference>
Your memory files are located in: ${memoryDir}
You can read SOUL.md and MEMORY.md if you need context about the user's preferences or prior interactions.
</memory_reference>`)
  }

  sections.push(`Your final message MUST follow this exact format:

STATUS: completed | failed
SUMMARY: <concise description of the result>

If you encounter an unrecoverable error, use STATUS: failed and explain what went wrong.`)

  return sections.join('\n\n')
}

/**
 * Parse the task agent's final output to extract status and summary
 */
function parseTaskOutput(text: string): { status: TaskResultStatus; summary: string } {
  const statusMatch = text.match(/STATUS:\s*(completed|failed|question)/i)
  const summaryMatch = text.match(/SUMMARY:\s*([\s\S]*?)$/im)

  const status = (statusMatch?.[1]?.toLowerCase() as TaskResultStatus) ?? 'completed'
  const summary = summaryMatch?.[1]?.trim() ?? text.trim().slice(0, 500)

  return { status, summary }
}

/**
 * Format a task injection message for the main agent
 */
export function formatTaskInjection(task: Task, durationMinutes: number): string {
  return `<task_injection task_id="${task.id}" task_name="${task.name}" status="${task.resultStatus ?? task.status}" trigger="${task.triggerType}" duration_minutes="${durationMinutes}" tokens_used="${task.promptTokens + task.completionTokens}">
${task.resultSummary ?? task.errorMessage ?? 'Task completed without summary.'}
</task_injection>`
}

/**
 * Task Runner — spawns and manages isolated PiAgent instances for background tasks
 */
export class TaskRunner {
  private store: TaskStore
  private db: Database
  private runningTasks: Map<string, RunningTask> = new Map()
  private options: TaskRunnerOptions

  constructor(options: TaskRunnerOptions) {
    this.options = options
    this.db = options.db
    this.store = new TaskStore(options.db)
  }

  /**
   * Get the task store
   */
  getStore(): TaskStore {
    return this.store
  }

  /**
   * Start a new task
   */
  async startTask(
    task: Task,
    provider: ProviderConfig,
  ): Promise<string> {
    const taskId = task.id
    const sessionId = task.sessionId ?? `task-${taskId}`

    // Build model and get API key
    const model = this.options.buildModel(provider)
    const apiKey = await this.options.getApiKey(provider)

    // Build task-specific system prompt
    const systemPrompt = buildTaskSystemPrompt(task.prompt, this.options.memoryDir)

    // Create isolated PiAgent
    const agent = new PiAgent({
      initialState: {
        systemPrompt,
        model,
        tools: this.options.tools,
      },
      getApiKey: () => apiKey,
    })

    const abortController = new AbortController()

    const runningTask: RunningTask = {
      taskId,
      agent,
      abortController,
      timeoutTimer: null,
      promptTokens: 0,
      completionTokens: 0,
      estimatedCost: 0,
      toolCallCount: 0,
      toolCallTimers: new Map(),
      toolCallArgs: new Map(),
    }

    // Set up max duration timeout
    if (task.maxDurationMinutes && task.maxDurationMinutes > 0) {
      runningTask.timeoutTimer = setTimeout(() => {
        this.abortTask(taskId, 'Max duration exceeded')
      }, task.maxDurationMinutes * 60 * 1000)
    }

    this.runningTasks.set(taskId, runningTask)

    // Update task as started
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19)
    this.store.update(taskId, {
      startedAt: now,
      provider: provider.name,
      model: provider.defaultModel,
    })

    // Subscribe to agent events for token/tool tracking
    const unsubscribe = agent.subscribe((event: AgentEvent) => {
      this.handleTaskEvent(runningTask, event, sessionId, model)
    })

    // Run the task asynchronously
    this.runTaskAsync(runningTask, unsubscribe, sessionId)

    return taskId
  }

  /**
   * Run the task agent asynchronously
   */
  private async runTaskAsync(
    runningTask: RunningTask,
    unsubscribe: () => void,
    sessionId: string,
  ): Promise<void> {
    const { taskId, agent } = runningTask

    try {
      // Prompt the task agent with the task — the system prompt already contains the full task description
      await agent.prompt('Begin working on the task described in your system prompt. Work autonomously and report your results when done.')

      // Task completed successfully
      unsubscribe()
      this.cleanupRunningTask(taskId)

      // Extract result from agent messages
      const messages = agent.state.messages
      const lastAssistantMsg = [...messages].reverse().find(
        (m) => 'role' in m && m.role === 'assistant'
      ) as AssistantMessage | undefined

      let resultText = ''
      if (lastAssistantMsg && 'content' in lastAssistantMsg && Array.isArray(lastAssistantMsg.content)) {
        resultText = lastAssistantMsg.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { type: string; text?: string }) => c.text ?? '')
          .join('')
      }

      const { status, summary } = parseTaskOutput(resultText)
      const now = new Date().toISOString().replace('T', ' ').slice(0, 19)

      const updatedTask = this.store.update(taskId, {
        status: status === 'failed' ? 'failed' : 'completed',
        resultStatus: status,
        resultSummary: summary,
        completedAt: now,
        promptTokens: runningTask.promptTokens,
        completionTokens: runningTask.completionTokens,
        estimatedCost: runningTask.estimatedCost,
        toolCallCount: runningTask.toolCallCount,
      })

      if (updatedTask) {
        const task = this.store.getById(taskId)!
        const startedAt = task.startedAt ? new Date(task.startedAt).getTime() : Date.now()
        const durationMinutes = Math.round((Date.now() - startedAt) / 60000)
        const injection = formatTaskInjection(task, durationMinutes)
        this.options.onTaskComplete(taskId, injection)
      }
    } catch (err) {
      // Task failed
      unsubscribe()
      this.cleanupRunningTask(taskId)

      const errorMessage = err instanceof Error ? err.message : String(err)
      const now = new Date().toISOString().replace('T', ' ').slice(0, 19)

      const updatedTask = this.store.update(taskId, {
        status: 'failed',
        resultStatus: 'failed',
        resultSummary: `Task failed with error: ${errorMessage}`,
        errorMessage,
        completedAt: now,
        promptTokens: runningTask.promptTokens,
        completionTokens: runningTask.completionTokens,
        estimatedCost: runningTask.estimatedCost,
        toolCallCount: runningTask.toolCallCount,
      })

      if (updatedTask) {
        const task = this.store.getById(taskId)!
        const startedAt = task.startedAt ? new Date(task.startedAt).getTime() : Date.now()
        const durationMinutes = Math.round((Date.now() - startedAt) / 60000)
        const injection = formatTaskInjection(task, durationMinutes)
        this.options.onTaskComplete(taskId, injection)
      }
    }
  }

  /**
   * Handle events from a task agent (token tracking, tool call logging)
   */
  private handleTaskEvent(
    runningTask: RunningTask,
    event: AgentEvent,
    sessionId: string,
    model: Model<Api>,
  ): void {
    switch (event.type) {
      case 'message_end': {
        const msg = event.message as Message
        if ('role' in msg && msg.role === 'assistant') {
          const assistantMsg = msg as AssistantMessage
          const cost = estimateCost(
            model,
            assistantMsg.usage.input,
            assistantMsg.usage.output,
            assistantMsg.usage.cacheRead,
            assistantMsg.usage.cacheWrite,
          )
          const finalCost = assistantMsg.usage.cost.total > 0
            ? assistantMsg.usage.cost.total
            : cost

          runningTask.promptTokens += assistantMsg.usage.input
          runningTask.completionTokens += assistantMsg.usage.output
          runningTask.estimatedCost += finalCost

          // Log to token_usage table with task's session_id
          logTokenUsage(this.db, {
            provider: assistantMsg.provider,
            model: assistantMsg.model,
            promptTokens: assistantMsg.usage.input,
            completionTokens: assistantMsg.usage.output,
            estimatedCost: finalCost,
            sessionId,
          })
        }
        break
      }

      case 'tool_execution_start': {
        runningTask.toolCallTimers.set(event.toolCallId, Date.now())
        runningTask.toolCallArgs.set(event.toolCallId, event.args)
        break
      }

      case 'tool_execution_end': {
        const startTime = runningTask.toolCallTimers.get(event.toolCallId) ?? Date.now()
        const durationMs = Date.now() - startTime
        const args = runningTask.toolCallArgs.get(event.toolCallId) ?? {}
        runningTask.toolCallTimers.delete(event.toolCallId)
        runningTask.toolCallArgs.delete(event.toolCallId)

        runningTask.toolCallCount++

        // Log to tool_calls table with task's session_id
        logToolCall(this.db, {
          sessionId,
          toolName: event.toolName,
          input: JSON.stringify(args),
          output: JSON.stringify(event.result ?? {}),
          durationMs,
        })
        break
      }
    }
  }

  /**
   * Abort a running task
   */
  abortTask(taskId: string, reason: string = 'Aborted by user'): void {
    const runningTask = this.runningTasks.get(taskId)
    if (!runningTask) return

    // Abort the agent
    runningTask.agent.abort()
    this.cleanupRunningTask(taskId)

    const now = new Date().toISOString().replace('T', ' ').slice(0, 19)
    this.store.update(taskId, {
      status: 'failed',
      resultStatus: 'failed',
      resultSummary: reason,
      errorMessage: reason,
      completedAt: now,
      promptTokens: runningTask.promptTokens,
      completionTokens: runningTask.completionTokens,
      estimatedCost: runningTask.estimatedCost,
      toolCallCount: runningTask.toolCallCount,
    })

    const task = this.store.getById(taskId)
    if (task) {
      const startedAt = task.startedAt ? new Date(task.startedAt).getTime() : Date.now()
      const durationMinutes = Math.round((Date.now() - startedAt) / 60000)
      const injection = formatTaskInjection(task, durationMinutes)
      this.options.onTaskComplete(taskId, injection)
    }
  }

  /**
   * Check if a task is currently running
   */
  isRunning(taskId: string): boolean {
    return this.runningTasks.has(taskId)
  }

  /**
   * Get all running task IDs
   */
  getRunningTaskIds(): string[] {
    return Array.from(this.runningTasks.keys())
  }

  /**
   * Clean up a running task's resources
   */
  private cleanupRunningTask(taskId: string): void {
    const runningTask = this.runningTasks.get(taskId)
    if (!runningTask) return

    if (runningTask.timeoutTimer) {
      clearTimeout(runningTask.timeoutTimer)
    }
    this.runningTasks.delete(taskId)
  }

  /**
   * Dispose all running tasks
   */
  dispose(): void {
    for (const [taskId, runningTask] of this.runningTasks) {
      runningTask.agent.abort()
      if (runningTask.timeoutTimer) {
        clearTimeout(runningTask.timeoutTimer)
      }
    }
    this.runningTasks.clear()
  }
}
