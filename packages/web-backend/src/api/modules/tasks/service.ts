import { TaskStore, getToolCalls } from '@openagent/core'
import type { Database, Task, TaskRuntimeTaskBoundary, TaskStatus, TaskTriggerType } from '@openagent/core'
import type { TaskTimelineEvent, TaskToolCallTimelineEvent } from './types.js'

export interface TasksServiceOptions {
  db: Database
  getTaskRuntime?: () => TaskRuntimeTaskBoundary | null
}

export interface ListTasksInput {
  status?: TaskStatus
  triggerType?: TaskTriggerType
  limit: number
  offset: number
}

export class TaskNotFoundError extends Error {
  constructor() {
    super('Task not found')
  }
}

export class TaskCannotBeKilledError extends Error {
  constructor(public readonly status: string) {
    super(`Cannot kill task with status '${status}'. Only running tasks can be killed.`)
  }
}

interface ChatMessageRow {
  role: string
  content: string
  metadata: string | null
  timestamp: string
}

export class TasksService {
  private readonly store: TaskStore

  constructor(private readonly options: TasksServiceOptions) {
    this.store = new TaskStore(options.db)
  }

  private getRuntime(): TaskRuntimeTaskBoundary | null {
    return this.options.getTaskRuntime?.() ?? null
  }

  listTasks(input: ListTasksInput): { tasks: Task[]; total: number } {
    const runtime = this.getRuntime()
    const tasks = runtime
      ? runtime.list({
          status: input.status,
          triggerType: input.triggerType,
          limit: input.limit,
          offset: input.offset,
        })
      : this.store.list({
          status: input.status,
          triggerType: input.triggerType,
          limit: input.limit,
          offset: input.offset,
        })

    let countSql = 'SELECT COUNT(*) as count FROM tasks WHERE 1=1'
    const countParams: unknown[] = []

    if (input.status) {
      countSql += ' AND status = ?'
      countParams.push(input.status)
    }

    if (input.triggerType) {
      countSql += ' AND trigger_type = ?'
      countParams.push(input.triggerType)
    }

    const total = (this.options.db.prepare(countSql).get(...countParams) as { count: number }).count

    return { tasks, total }
  }

  getTaskById(id: string): Task | null {
    const runtime = this.getRuntime()
    return runtime ? runtime.getById(id) : this.store.getById(id)
  }

  getTaskEvents(taskId: string): { task: Task; events: TaskTimelineEvent[] } {
    const task = this.getTaskById(taskId)
    if (!task) {
      throw new TaskNotFoundError()
    }

    // Tasks created since PRD #11 always have a UUID sessionId registered
    // in the `sessions` table. Legacy tasks without a sessionId have no
    // historical events to load.
    const sessionId = task.sessionId
    if (!sessionId) {
      return { task, events: [] }
    }

    const toolCalls: TaskToolCallTimelineEvent[] = getToolCalls(this.options.db, { sessionId })
      .reverse()
      .map((toolCall) => ({
        type: 'tool_call' as const,
        timestamp: toolCall.timestamp,
        toolName: toolCall.toolName,
        input: toolCall.input,
        output: toolCall.output,
        durationMs: toolCall.durationMs,
        status: toolCall.status ?? 'success',
      }))

    const messages = (this.options.db.prepare(
      'SELECT role, content, metadata, timestamp FROM chat_messages WHERE session_id = ? ORDER BY timestamp ASC',
    ).all(sessionId) as ChatMessageRow[])
      .filter((message) => message.role === 'assistant' || message.role === 'system')
      .map((message) => ({
        type: 'message' as const,
        timestamp: message.timestamp,
        role: message.role,
        content: message.content,
        metadata: safeParseJson(message.metadata),
      }))

    const events = [...toolCalls, ...messages].sort((a, b) =>
      (a.timestamp ?? '').localeCompare(b.timestamp ?? ''),
    )

    return { task, events }
  }

  killTask(taskId: string): Task {
    const task = this.getTaskById(taskId)
    if (!task) {
      throw new TaskNotFoundError()
    }

    if (task.status !== 'running') {
      throw new TaskCannotBeKilledError(task.status)
    }

    const runtime = this.getRuntime()
    if (runtime) {
      runtime.abort(task.id, 'Killed by user from web UI')
    } else {
      const now = new Date().toISOString().replace('T', ' ').slice(0, 19)
      this.store.update(task.id, {
        status: 'failed',
        resultStatus: 'failed',
        resultSummary: 'Killed by user from web UI',
        errorMessage: 'Killed by user from web UI',
        completedAt: now,
      })
    }

    const updatedTask = this.getTaskById(task.id)
    if (!updatedTask) {
      throw new TaskNotFoundError()
    }

    return updatedTask
  }
}

export function createTasksService(options: TasksServiceOptions): TasksService {
  return new TasksService(options)
}

function safeParseJson(rawValue: string | null): unknown {
  if (!rawValue) return null
  try {
    return JSON.parse(rawValue)
  } catch {
    // Historical rows may contain non-JSON metadata (legacy data, truncation,
    // etc.). Fall back to the raw string so a single bad row doesn't break
    // the whole timeline request.
    return rawValue
  }
}
