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
import {
  ToolCallTracker,
  buildSmartDetectionPrompt,
  parseSmartDetectionResponse,
  resolveDetectionMethod,
  formatPeriodicStatusUpdate,
} from './loop-detection.js'
import type { LoopDetectionConfig, LoopDetectionResult } from './loop-detection.js'
import type { TaskEventBus } from './task-event-bus.js'

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
  /** Callback when a task pauses with a question — delivers the injection message */
  onTaskPaused?: (taskId: string, injection: string) => void
  /** Callback for periodic status updates */
  onStatusUpdate?: (taskId: string, statusMessage: string) => void
  /** Loop detection configuration */
  loopDetection?: LoopDetectionConfig
  /** Status update interval in minutes */
  statusUpdateIntervalMinutes?: number
  /** Function to resolve a provider config by ID (for smart detection) */
  getProviderById?: (providerId: string) => ProviderConfig | null
  /** Optional event bus for streaming task execution events to WebSocket clients */
  taskEventBus?: TaskEventBus
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
  /** Tracker for loop detection */
  toolCallTracker: ToolCallTracker
  /** Timer for periodic status updates */
  statusUpdateTimer: ReturnType<typeof setInterval> | null
  /** When the task started running (for status update runtime calc) */
  startedAtMs: number
}

interface PausedTask {
  taskId: string
  agent: PiAgent
  provider: ProviderConfig
  pausedAt: number
  promptTokens: number
  completionTokens: number
  estimatedCost: number
  toolCallCount: number
}

/** Interval for cleaning up stale paused tasks (1 hour) */
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000
/** Max time a task can remain paused before being cleaned up (24 hours) */
const MAX_PAUSE_DURATION_MS = 24 * 60 * 60 * 1000

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
  private pausedTasks: Map<string, PausedTask> = new Map()
  private options: TaskRunnerOptions
  private cleanupTimer: ReturnType<typeof setInterval> | null = null

  constructor(options: TaskRunnerOptions) {
    this.options = options
    this.db = options.db
    this.store = new TaskStore(options.db)

    // Start periodic cleanup of stale paused tasks
    this.cleanupTimer = setInterval(() => this.cleanupStalePausedTasks(), CLEANUP_INTERVAL_MS)
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
      toolCallTracker: new ToolCallTracker(),
      statusUpdateTimer: null,
      startedAtMs: Date.now(),
    }

    // Set up max duration timeout
    if (task.maxDurationMinutes && task.maxDurationMinutes > 0) {
      runningTask.timeoutTimer = setTimeout(() => {
        this.abortTask(taskId, 'Max duration exceeded')
      }, task.maxDurationMinutes * 60 * 1000)
    }

    // Set up periodic status updates
    const statusIntervalMinutes = this.options.statusUpdateIntervalMinutes ?? 10
    if (statusIntervalMinutes > 0 && this.options.onStatusUpdate) {
      runningTask.statusUpdateTimer = setInterval(() => {
        this.emitStatusUpdate(runningTask, task)
      }, statusIntervalMinutes * 60 * 1000)
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

      // Handle "question" status — pause the task instead of completing
      if (status === 'question') {
        // Clear the timeout but keep the agent in memory
        if (runningTask.timeoutTimer) {
          clearTimeout(runningTask.timeoutTimer)
          runningTask.timeoutTimer = null
        }
        this.runningTasks.delete(taskId)

        // Store as paused task
        const pausedTask: PausedTask = {
          taskId,
          agent: runningTask.agent,
          provider: {} as ProviderConfig, // provider info already saved in DB
          pausedAt: Date.now(),
          promptTokens: runningTask.promptTokens,
          completionTokens: runningTask.completionTokens,
          estimatedCost: runningTask.estimatedCost,
          toolCallCount: runningTask.toolCallCount,
        }
        this.pausedTasks.set(taskId, pausedTask)

        this.store.update(taskId, {
          status: 'paused',
          resultStatus: 'question',
          resultSummary: summary,
          promptTokens: runningTask.promptTokens,
          completionTokens: runningTask.completionTokens,
          estimatedCost: runningTask.estimatedCost,
          toolCallCount: runningTask.toolCallCount,
        })

        // Notify via injection with question status
        const task = this.store.getById(taskId)!
        const startedAt = task.startedAt ? new Date(task.startedAt).getTime() : Date.now()
        const durationMinutes = Math.round((Date.now() - startedAt) / 60000)
        const injection = formatTaskInjection(task, durationMinutes)
        this.notifyTaskPaused(taskId, injection, summary)
        unsubscribe()
        return
      }

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
        this.notifyTaskComplete(taskId, injection, task.status, task.resultSummary ?? undefined)
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
        this.notifyTaskComplete(taskId, injection, "failed", errorMessage)
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
      case 'message_update': {
        // Emit text deltas to task event bus
        const assistantEvent = event.assistantMessageEvent
        if (assistantEvent.type === 'text_delta') {
          this.options.taskEventBus?.emitTaskEvent({
            type: 'text_delta',
            taskId: runningTask.taskId,
            timestamp: new Date().toISOString(),
            text: assistantEvent.delta,
          })
        }
        break
      }

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

        // Emit to task event bus
        this.options.taskEventBus?.emitTaskEvent({
          type: 'tool_call_start',
          taskId: runningTask.taskId,
          timestamp: new Date().toISOString(),
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          toolArgs: event.args,
        })
        break
      }

      case 'tool_execution_end': {
        const startTime = runningTask.toolCallTimers.get(event.toolCallId) ?? Date.now()
        const durationMs = Date.now() - startTime
        const args = runningTask.toolCallArgs.get(event.toolCallId) ?? {}
        runningTask.toolCallTimers.delete(event.toolCallId)
        runningTask.toolCallArgs.delete(event.toolCallId)

        runningTask.toolCallCount++

        const outputStr = JSON.stringify(event.result ?? {})
        const isError = event.isError === true || (typeof event.result === 'string' && event.result.startsWith('Error'))

        // Track for loop detection
        runningTask.toolCallTracker.record(event.toolName, args, outputStr, isError)

        // Check for loops
        this.checkForLoops(runningTask)

        // Emit to task event bus
        this.options.taskEventBus?.emitTaskEvent({
          type: 'tool_call_end',
          taskId: runningTask.taskId,
          timestamp: new Date().toISOString(),
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          toolResult: event.result,
          toolIsError: isError,
          durationMs,
        })

        // Log to tool_calls table with task's session_id
        logToolCall(this.db, {
          sessionId,
          toolName: event.toolName,
          input: JSON.stringify(args),
          output: outputStr,
          durationMs,
        })
        break
      }
    }
  }

  /**
   * Check for loops after each tool call
   */
  private checkForLoops(runningTask: RunningTask): void {
    const config = this.options.loopDetection
    if (!config?.enabled) return

    const method = resolveDetectionMethod(config, runningTask.toolCallCount)
    if (method === 'none') return

    if (method === 'systematic') {
      const result = runningTask.toolCallTracker.checkSystematicLoop(config.maxConsecutiveFailures)
      if (result.loopDetected) {
        this.handleLoopDetected(runningTask, result)
      }
    } else if (method === 'smart') {
      // Smart detection runs every M tool calls
      const checkInterval = config.smartCheckInterval ?? 5
      if (runningTask.toolCallCount % checkInterval === 0) {
        this.runSmartDetection(runningTask).catch(err => {
          console.error(`[task-runner] Smart loop detection error for task ${runningTask.taskId}:`, err)
        })
      }
    }
  }

  /**
   * Run LLM-based smart loop detection
   */
  private async runSmartDetection(runningTask: RunningTask): Promise<void> {
    const config = this.options.loopDetection
    if (!config?.smartProvider || !this.options.getProviderById) return

    const provider = this.options.getProviderById(config.smartProvider)
    if (!provider) return

    try {
      const model = this.options.buildModel(provider)
      const apiKey = await this.options.getApiKey(provider)
      const prompt = buildSmartDetectionPrompt(runningTask.toolCallTracker.getHistory())

      // Create a lightweight agent for the detection call
      const detectionAgent = new PiAgent({
        initialState: {
          systemPrompt: 'You are a loop detection assistant. Analyze tool call patterns and determine if an agent is making progress or stuck.',
          model,
          tools: [],
        },
        getApiKey: () => apiKey,
      })

      // Track token usage from detection
      const sessionId = `loop-detection-${runningTask.taskId}`
      detectionAgent.subscribe((event: AgentEvent) => {
        if (event.type === 'message_end') {
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

            logTokenUsage(this.db, {
              provider: assistantMsg.provider,
              model: assistantMsg.model,
              promptTokens: assistantMsg.usage.input,
              completionTokens: assistantMsg.usage.output,
              estimatedCost: finalCost,
              sessionId,
            })
          }
        }
      })

      await detectionAgent.prompt(prompt)

      // Extract response
      const messages = detectionAgent.state.messages
      const lastMsg = [...messages].reverse().find(
        (m) => 'role' in m && m.role === 'assistant'
      ) as AssistantMessage | undefined

      let responseText = ''
      if (lastMsg && 'content' in lastMsg && Array.isArray(lastMsg.content)) {
        responseText = lastMsg.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { type: string; text?: string }) => c.text ?? '')
          .join('')
      }

      const result = parseSmartDetectionResponse(responseText)
      if (result.loopDetected) {
        this.handleLoopDetected(runningTask, result)
      }
    } catch (err) {
      console.error(`[task-runner] Smart detection failed for task ${runningTask.taskId}:`, err)
    }
  }

  /**
   * Handle a detected loop — fail the task and notify
   */
  private handleLoopDetected(runningTask: RunningTask, result: LoopDetectionResult): void {
    const { taskId } = runningTask
    const reason = `Loop detected (${result.method}): ${result.details}`

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
      const injection = `<task_injection task_id="${task.id}" task_name="${task.name}" status="failed" trigger="${task.triggerType}" duration_minutes="${durationMinutes}" tokens_used="${task.promptTokens + task.completionTokens}">
${reason}
Hint: Use /kill_task ${task.id} if the task needs to be cleaned up.
</task_injection>`
      this.notifyTaskComplete(taskId, injection, "failed", reason)
    }
  }

  /**
   * Emit a periodic status update for a running task
   */
  private emitStatusUpdate(runningTask: RunningTask, task: Task): void {
    if (!this.options.onStatusUpdate) return
    if (!this.runningTasks.has(runningTask.taskId)) return

    const runtimeMinutes = Math.round((Date.now() - runningTask.startedAtMs) / 60000)
    const totalTokens = runningTask.promptTokens + runningTask.completionTokens

    const statusMessage = formatPeriodicStatusUpdate(
      task.id,
      task.name,
      runtimeMinutes,
      runningTask.toolCallCount,
      totalTokens,
    )

    this.options.onStatusUpdate(task.id, statusMessage)
  }

  /**
   * Emit a status change event to the task event bus
   */
  private emitStatusChange(taskId: string, status: string, message?: string): void {
    this.options.taskEventBus?.emitTaskEvent({
      type: 'status_change',
      taskId,
      timestamp: new Date().toISOString(),
      status,
      statusMessage: message,
    })
  }

  /**
   * Notify completion/failure and emit status change
   */
  private notifyTaskComplete(taskId: string, injection: string, status: string, message?: string): void {
    this.emitStatusChange(taskId, status, message)
    this.options.onTaskComplete(taskId, injection)
  }

  /**
   * Notify task paused and emit status change
   */
  private notifyTaskPaused(taskId: string, injection: string, message?: string): void {
    this.emitStatusChange(taskId, 'paused', message)
    this.options.onTaskPaused?.(taskId, injection)
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
      this.notifyTaskComplete(taskId, injection, "failed", reason)
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
    if (runningTask.statusUpdateTimer) {
      clearInterval(runningTask.statusUpdateTimer)
    }
    this.runningTasks.delete(taskId)
  }

  /**
   * Check if a task is currently paused
   */
  isPaused(taskId: string): boolean {
    return this.pausedTasks.has(taskId)
  }

  /**
   * Get all paused task IDs
   */
  getPausedTaskIds(): string[] {
    return Array.from(this.pausedTasks.keys())
  }

  /**
   * Resume a paused task by sending a follow-up message
   */
  async resumeTask(taskId: string, message: string): Promise<boolean> {
    const pausedTask = this.pausedTasks.get(taskId)
    if (!pausedTask) return false

    // Remove from paused map
    this.pausedTasks.delete(taskId)

    // Update status back to running
    this.store.update(taskId, {
      status: 'running',
    })

    const { agent } = pausedTask
    const sessionId = this.store.getById(taskId)?.sessionId ?? `task-${taskId}`
    const model = {} as Model<Api> // model info is in the agent already

    // Create a new RunningTask entry
    const task = this.store.getById(taskId)!
    const runningTask: RunningTask = {
      taskId,
      agent,
      abortController: new AbortController(),
      timeoutTimer: null,
      promptTokens: pausedTask.promptTokens,
      completionTokens: pausedTask.completionTokens,
      estimatedCost: pausedTask.estimatedCost,
      toolCallCount: pausedTask.toolCallCount,
      toolCallTimers: new Map(),
      toolCallArgs: new Map(),
      toolCallTracker: new ToolCallTracker(),
      statusUpdateTimer: null,
      startedAtMs: task.startedAt ? new Date(task.startedAt).getTime() : Date.now(),
    }

    // Set up periodic status updates for resumed task
    const statusIntervalMinutes = this.options.statusUpdateIntervalMinutes ?? 10
    if (statusIntervalMinutes > 0 && this.options.onStatusUpdate) {
      runningTask.statusUpdateTimer = setInterval(() => {
        this.emitStatusUpdate(runningTask, task)
      }, statusIntervalMinutes * 60 * 1000)
    }

    this.runningTasks.set(taskId, runningTask)

    // Subscribe to events for the resumed task
    const unsubscribe = agent.subscribe((event: AgentEvent) => {
      this.handleTaskEvent(runningTask, event, sessionId, model)
    })

    // Send the follow-up message to the agent, which resumes execution
    this.runResumedTaskAsync(runningTask, unsubscribe, sessionId, message)

    return true
  }

  /**
   * Run a resumed task asynchronously (after receiving a follow-up)
   */
  private async runResumedTaskAsync(
    runningTask: RunningTask,
    unsubscribe: () => void,
    sessionId: string,
    message: string,
  ): Promise<void> {
    const { taskId, agent } = runningTask

    try {
      // Send the follow-up via prompt (which adds a user message and continues the agentic loop)
      await agent.prompt(message)

      // Task completed after resume
      unsubscribe()
      this.cleanupRunningTask(taskId)

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

      // Handle nested question (task pauses again)
      if (status === 'question') {
        if (runningTask.timeoutTimer) {
          clearTimeout(runningTask.timeoutTimer)
          runningTask.timeoutTimer = null
        }
        this.runningTasks.delete(taskId)

        const pausedTask: PausedTask = {
          taskId,
          agent: runningTask.agent,
          provider: {} as ProviderConfig,
          pausedAt: Date.now(),
          promptTokens: runningTask.promptTokens,
          completionTokens: runningTask.completionTokens,
          estimatedCost: runningTask.estimatedCost,
          toolCallCount: runningTask.toolCallCount,
        }
        this.pausedTasks.set(taskId, pausedTask)

        this.store.update(taskId, {
          status: 'paused',
          resultStatus: 'question',
          resultSummary: summary,
          promptTokens: runningTask.promptTokens,
          completionTokens: runningTask.completionTokens,
          estimatedCost: runningTask.estimatedCost,
          toolCallCount: runningTask.toolCallCount,
        })

        const task = this.store.getById(taskId)!
        const startedAt = task.startedAt ? new Date(task.startedAt).getTime() : Date.now()
        const durationMinutes = Math.round((Date.now() - startedAt) / 60000)
        const injection = formatTaskInjection(task, durationMinutes)
        this.notifyTaskPaused(taskId, injection, summary)
        return
      }

      this.store.update(taskId, {
        status: status === 'failed' ? 'failed' : 'completed',
        resultStatus: status,
        resultSummary: summary,
        completedAt: now,
        promptTokens: runningTask.promptTokens,
        completionTokens: runningTask.completionTokens,
        estimatedCost: runningTask.estimatedCost,
        toolCallCount: runningTask.toolCallCount,
      })

      const task = this.store.getById(taskId)!
      const startedAt = task.startedAt ? new Date(task.startedAt).getTime() : Date.now()
      const durationMinutes = Math.round((Date.now() - startedAt) / 60000)
      const injection = formatTaskInjection(task, durationMinutes)
      this.notifyTaskComplete(taskId, injection, task.status, task.resultSummary ?? undefined)
    } catch (err) {
      unsubscribe()
      this.cleanupRunningTask(taskId)

      const errorMessage = err instanceof Error ? err.message : String(err)
      const now = new Date().toISOString().replace('T', ' ').slice(0, 19)

      this.store.update(taskId, {
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

      const task = this.store.getById(taskId)!
      const startedAt = task.startedAt ? new Date(task.startedAt).getTime() : Date.now()
      const durationMinutes = Math.round((Date.now() - startedAt) / 60000)
      const injection = formatTaskInjection(task, durationMinutes)
      this.notifyTaskComplete(taskId, injection, "failed", errorMessage)
    }
  }

  /**
   * Clean up paused tasks that have been waiting for >24 hours
   */
  cleanupStalePausedTasks(): number {
    let cleanedCount = 0
    const now = Date.now()

    for (const [taskId, pausedTask] of this.pausedTasks) {
      if (now - pausedTask.pausedAt >= MAX_PAUSE_DURATION_MS) {
        // Free the agent from memory
        pausedTask.agent.abort()
        this.pausedTasks.delete(taskId)

        // Mark as failed in DB
        const nowStr = new Date().toISOString().replace('T', ' ').slice(0, 19)
        this.store.update(taskId, {
          status: 'failed',
          resultStatus: 'failed',
          resultSummary: 'timeout — no response received',
          errorMessage: 'timeout — no response received',
          completedAt: nowStr,
          promptTokens: pausedTask.promptTokens,
          completionTokens: pausedTask.completionTokens,
          estimatedCost: pausedTask.estimatedCost,
          toolCallCount: pausedTask.toolCallCount,
        })

        // Notify via injection
        const task = this.store.getById(taskId)
        if (task) {
          const startedAt = task.startedAt ? new Date(task.startedAt).getTime() : Date.now()
          const durationMinutes = Math.round((Date.now() - startedAt) / 60000)
          const injection = formatTaskInjection(task, durationMinutes)
          this.notifyTaskComplete(taskId, injection, "failed", "timeout — no response received")
        }

        cleanedCount++
      }
    }

    return cleanedCount
  }

  /**
   * Recover tasks after server restart.
   * - `running` tasks: re-start with original prompt + progress summary
   * - `paused` tasks: mark as failed with "server restart" reason
   */
  async recoverTasks(
    getProvider: (name: string) => ProviderConfig | null,
    defaultProvider: ProviderConfig,
  ): Promise<{ resumed: number; failed: number }> {
    let resumed = 0
    let failed = 0

    // Handle paused tasks — mark as failed
    const pausedTasks = this.store.list({ status: 'paused' })
    for (const task of pausedTasks) {
      const now = new Date().toISOString().replace('T', ' ').slice(0, 19)
      this.store.update(task.id, {
        status: 'failed',
        resultStatus: 'failed',
        resultSummary: 'server restart — please re-ask your question',
        errorMessage: 'server restart',
        completedAt: now,
      })
      failed++
    }

    // Handle running tasks — build summary from stored tool_calls and re-start
    const runningTasks = this.store.list({ status: 'running' })
    for (const task of runningTasks) {
      const provider = (task.provider ? getProvider(task.provider) : null) ?? defaultProvider

      // Build a progress summary from stored tool calls
      const toolCalls = this.db.prepare(
        'SELECT tool_name, output FROM tool_calls WHERE session_id = ? ORDER BY timestamp ASC'
      ).all(task.sessionId ?? `task-${task.id}`) as { tool_name: string; output: string }[]

      let progressSummary = ''
      if (toolCalls.length > 0) {
        const toolSummaries = toolCalls.slice(-10).map(tc => {
          const outputPreview = tc.output?.slice(0, 200) ?? ''
          return `- ${tc.tool_name}: ${outputPreview}`
        })
        progressSummary = `\n\nProgress from previous run (${toolCalls.length} tool calls made):\n${toolSummaries.join('\n')}`
      }

      // Create a new task entry for the resumed run
      const resumedTask = this.store.create({
        name: `${task.name} (resumed)`,
        prompt: `${task.prompt}${progressSummary}\n\nNote: This task was interrupted by a server restart. Continue from where you left off.`,
        triggerType: task.triggerType,
        triggerSourceId: task.triggerSourceId ?? undefined,
        maxDurationMinutes: task.maxDurationMinutes ?? undefined,
        sessionId: task.sessionId ?? undefined,
      })

      // Mark the old task as failed
      const now = new Date().toISOString().replace('T', ' ').slice(0, 19)
      this.store.update(task.id, {
        status: 'failed',
        resultStatus: 'failed',
        resultSummary: 'server restart — task being resumed',
        errorMessage: 'server restart',
        completedAt: now,
      })

      try {
        await this.startTask(resumedTask, provider)
        resumed++
      } catch {
        // If we can't start the resumed task, mark it as failed too
        this.store.update(resumedTask.id, {
          status: 'failed',
          resultStatus: 'failed',
          resultSummary: 'Failed to resume after server restart',
          errorMessage: 'Failed to resume after server restart',
          completedAt: now,
        })
        failed++
      }
    }

    return { resumed, failed }
  }

  /**
   * Dispose all running and paused tasks, stop cleanup timer
   */
  dispose(): void {
    // Stop cleanup timer
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }

    // Abort running tasks
    for (const [taskId, runningTask] of this.runningTasks) {
      runningTask.agent.abort()
      if (runningTask.timeoutTimer) {
        clearTimeout(runningTask.timeoutTimer)
      }
      if (runningTask.statusUpdateTimer) {
        clearInterval(runningTask.statusUpdateTimer)
      }
    }
    this.runningTasks.clear()

    // Free paused tasks
    for (const [taskId, pausedTask] of this.pausedTasks) {
      pausedTask.agent.abort()
    }
    this.pausedTasks.clear()
  }
}
