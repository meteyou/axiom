import { TaskStore, getToolCalls, resolveProviderModelInput } from '@openagent/core'
import type {
  Database,
  ProviderConfig,
  Task,
  TaskRuntimeTaskBoundary,
  TaskStatus,
  TaskTriggerType,
} from '@openagent/core'
import type { RestartTaskInput } from './schema.js'
import type { TaskTimelineEvent, TaskToolCallTimelineEvent } from './types.js'

export interface TasksServiceOptions {
  db: Database
  getTaskRuntime?: () => TaskRuntimeTaskBoundary | null
  /**
   * Resolve a provider by id or name. Required for `restartTask` so the
   * service can look up the (possibly overridden) provider the user chose
   * in the edit form. Injected from the runtime composition so the service
   * stays testable without pulling the whole provider registry.
   */
  resolveProvider?: (nameOrId: string) => ProviderConfig | null
  /**
   * Resolve the current default task provider, used by `restartTask` when
   * neither the user nor the original task pinned a specific provider.
   */
  getDefaultProvider?: () => ProviderConfig | null
}

export interface ListTasksInput {
  status?: TaskStatus
  triggerType?: TaskTriggerType
  provider?: string
  model?: string
  isDefaultModel?: boolean
  createdFrom?: string
  createdTo?: string
  limit: number
  offset: number
}

export interface TaskProviderFilterOption {
  provider: string | null
  model: string | null
  isDefaultModel: boolean | null
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

export class TaskCannotBeRestartedError extends Error {
  constructor(public readonly status: string) {
    super(`Cannot restart task with status '${status}'. Kill the task first, then restart.`)
  }
}

export class TaskRestartProviderError extends Error {
  constructor(message: string) {
    super(message)
  }
}

export class TaskRuntimeUnavailableError extends Error {
  constructor() {
    super('Task runtime is not available — cannot restart task.')
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

  listTasks(input: ListTasksInput): { tasks: Task[]; total: number; providerOptions: TaskProviderFilterOption[] } {
    const listFilters = {
      status: input.status,
      triggerType: input.triggerType,
      provider: input.provider,
      model: input.model,
      isDefaultModel: input.isDefaultModel,
      createdFrom: input.createdFrom,
      createdTo: input.createdTo,
      limit: input.limit,
      offset: input.offset,
    }

    const runtime = this.getRuntime()
    const tasks = runtime
      ? runtime.list(listFilters)
      : this.store.list(listFilters)

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

    if (input.isDefaultModel !== undefined) {
      countSql += ' AND is_default_model = ?'
      countParams.push(input.isDefaultModel ? 1 : 0)
    }

    if (input.provider) {
      countSql += ' AND provider = ?'
      countParams.push(input.provider)
    }

    if (input.model) {
      countSql += ' AND model = ?'
      countParams.push(input.model)
    }

    if (input.createdFrom) {
      countSql += ' AND datetime(created_at) >= datetime(?)'
      countParams.push(input.createdFrom)
    }

    if (input.createdTo) {
      countSql += ' AND datetime(created_at) <= datetime(?)'
      countParams.push(input.createdTo)
    }

    const total = (this.options.db.prepare(countSql).get(...countParams) as { count: number }).count
    const providerOptions = this.listProviderFilterOptions(input)

    return { tasks, total, providerOptions }
  }

  private listProviderFilterOptions(input: ListTasksInput): TaskProviderFilterOption[] {
    // Provider choices must come from historical task rows for the current
    // non-provider filters (especially date range), not from today's provider
    // configuration. Intentionally ignore input.provider/model here so the
    // dropdown still shows sibling options while one provider is selected.
    let sql = `
      SELECT provider, model, is_default_model
      FROM tasks
      WHERE 1=1
        AND (provider IS NOT NULL OR model IS NOT NULL OR is_default_model = 1)
    `
    const params: unknown[] = []

    if (input.status) {
      sql += ' AND status = ?'
      params.push(input.status)
    }

    if (input.triggerType) {
      sql += ' AND trigger_type = ?'
      params.push(input.triggerType)
    }

    if (input.createdFrom) {
      sql += ' AND datetime(created_at) >= datetime(?)'
      params.push(input.createdFrom)
    }

    if (input.createdTo) {
      sql += ' AND datetime(created_at) <= datetime(?)'
      params.push(input.createdTo)
    }

    sql += ' GROUP BY provider, model, is_default_model ORDER BY lower(provider), lower(model)'

    const rows = this.options.db.prepare(sql).all(...params) as Array<{
      provider: string | null
      model: string | null
      is_default_model: number | null
    }>

    return rows.map(row => ({
      provider: row.provider,
      model: row.model,
      isDefaultModel:
        row.is_default_model === null || row.is_default_model === undefined
          ? null
          : row.is_default_model === 1,
    }))
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

  /**
   * Clone the given task into a new row with optional field overrides and
   * start it immediately. The original row is left untouched — historical
   * tasks stay visible with their results / failure reasons intact.
   *
   * Rules (agreed with the user):
   *   - Only allowed on `completed` / `failed` tasks. `running` / `paused`
   *     must be killed first.
   *   - The new task always has `triggerType='user'`, even when the original
   *     was a `cronjob` / `heartbeat` / `consolidation` — the user triggered
   *     this run manually, so the cronjob binding is not inherited.
   *   - Any field the client omits inherits from the original.
   *   - The new task gets a fresh session id (handled by the task runner).
   */
  async restartTask(taskId: string, overrides: RestartTaskInput): Promise<Task> {
    const original = this.getTaskById(taskId)
    if (!original) {
      throw new TaskNotFoundError()
    }

    if (original.status === 'running' || original.status === 'paused') {
      throw new TaskCannotBeRestartedError(original.status)
    }

    const runtime = this.getRuntime()
    if (!runtime) {
      throw new TaskRuntimeUnavailableError()
    }

    // Resolve (provider, model): explicit override wins; otherwise inherit
    // the original's pinned provider/model; otherwise fall back to the
    // configured task default. This matches the behaviour of `create_task`.
    const providerInput = overrides.provider ?? original.provider ?? undefined
    const modelInput = overrides.model ?? original.model ?? undefined

    let provider: ProviderConfig
    let isDefaultModel: boolean

    if (providerInput || modelInput) {
      const resolved = resolveProviderModelInput({ provider: providerInput, model: modelInput })
      if (!resolved.ok) {
        throw new TaskRestartProviderError(resolved.error)
      }
      const base = this.options.resolveProvider?.(resolved.providerId) ?? null
      if (!base) {
        throw new TaskRestartProviderError(
          `Provider "${resolved.providerName}" could not be loaded.`,
        )
      }
      provider = resolved.modelId === base.defaultModel
        ? base
        : { ...base, defaultModel: resolved.modelId }
      // Only treat as "default" when the client explicitly selected no
      // provider/model *and* we fell back to default above — which isn't
      // this branch.
      isDefaultModel = false
    } else {
      const def = this.options.getDefaultProvider?.() ?? null
      if (!def) {
        throw new TaskRestartProviderError(
          'No default task provider is configured. Set one in Settings → Tasks, or pick a provider in the restart form.',
        )
      }
      provider = def
      isDefaultModel = true
    }

    // Build the new task row. The new task always becomes a user-triggered
    // task, with no link back to the original cronjob/heartbeat schedule.
    const newTask = runtime.create({
      name: overrides.name ?? original.name,
      prompt: overrides.prompt ?? original.prompt,
      triggerType: 'user',
      provider: provider.name,
      model: provider.defaultModel,
      isDefaultModel,
      maxDurationMinutes: overrides.maxDurationMinutes
        ?? (original.maxDurationMinutes ?? undefined),
    })

    // Start the task. `startTask` now marks the row as `failed` on early
    // setup errors (invalid provider, missing API key, …), so a throw here
    // leaves the DB consistent. We surface the error to the caller so the
    // UI can show it instead of silently landing on a failed row.
    await runtime.start(newTask, provider)

    // Re-fetch to capture `startedAt` / status updates from the runner.
    return this.getTaskById(newTask.id) ?? newTask
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
