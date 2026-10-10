import { randomUUID } from 'node:crypto'
import type { Database } from './database.js'
import type { SettingsThinkingLevel } from './contracts/settings.js'
import { normalizeThinkingLevel } from './thinking-level.js'
import { getBootstrapAdminId } from './user-scope.js'

export type TaskStatus = 'running' | 'paused' | 'completed' | 'failed'
export type TaskTriggerType = 'user' | 'agent' | 'cronjob' | 'heartbeat' | 'consolidation'
export type TaskResultStatus = 'completed' | 'failed' | 'question' | 'silent'

export interface Task {
  id: string
  name: string
  prompt: string
  status: TaskStatus
  triggerType: TaskTriggerType
  triggerSourceId: string | null
  provider: string | null
  model: string | null
  /**
   * Whether the (provider, model) pair used to run this task came from the
   * configured task default (Settings → Tasks → Default Provider) rather than
   * an explicit override by the user or agent. `null` means the flag was not
   * recorded (legacy rows created before this column existed).
   */
  isDefaultModel: boolean | null
  /** Explicitly requested thinking level; `null` = the background default at start time. */
  thinkingLevel: SettingsThinkingLevel | null
  /** Level the task agent actually ran with (requested level clamped to the model); `null` until started. */
  effectiveThinkingLevel: SettingsThinkingLevel | null
  maxDurationMinutes: number | null
  promptTokens: number
  completionTokens: number
  cacheRead: number
  cacheWrite: number
  estimatedCost: number
  toolCallCount: number
  resultSummary: string | null
  resultStatus: TaskResultStatus | null
  errorMessage: string | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  sessionId: string | null
  /** User the task belongs to; `null` only on instances without any user. */
  ownerUserId: number | null
}

export interface CreateTaskInput {
  name: string
  prompt: string
  triggerType: TaskTriggerType
  triggerSourceId?: string
  provider?: string
  model?: string
  /**
   * Set to `true` when (provider, model) come from the configured task
   * default, `false` when the caller explicitly pinned a provider/model.
   * Leave unset for legacy paths that do not track this distinction.
   */
  isDefaultModel?: boolean
  thinkingLevel?: SettingsThinkingLevel | null
  maxDurationMinutes?: number
  sessionId?: string
  /** Defaults to the bootstrap admin (system jobs without a user). */
  ownerUserId?: number
}

export interface UpdateTaskInput {
  status?: TaskStatus
  provider?: string
  model?: string
  effectiveThinkingLevel?: SettingsThinkingLevel
  promptTokens?: number
  completionTokens?: number
  cacheRead?: number
  cacheWrite?: number
  estimatedCost?: number
  toolCallCount?: number
  resultSummary?: string
  resultStatus?: TaskResultStatus
  errorMessage?: string
  startedAt?: string
  completedAt?: string
  sessionId?: string
}

export interface TaskListFilters {
  ownerUserId?: number
  status?: TaskStatus
  triggerType?: TaskTriggerType
  provider?: string
  model?: string
  isDefaultModel?: boolean
  createdFrom?: string
  createdTo?: string
  limit?: number
  offset?: number
}

export interface TaskFilterClauseOptions {
  includeProviderModel?: boolean
}

export interface TaskFilterClause {
  sql: string
  params: unknown[]
}

export function buildTaskFilterClause(
  filters?: TaskListFilters,
  options: TaskFilterClauseOptions = {},
): TaskFilterClause {
  const includeProviderModel = options.includeProviderModel ?? true
  let sql = ''
  const params: unknown[] = []

  if (filters?.ownerUserId !== undefined) {
    sql += ' AND owner_user_id = ?'
    params.push(filters.ownerUserId)
  }
  if (filters?.status) {
    sql += ' AND status = ?'
    params.push(filters.status)
  }
  if (filters?.triggerType) {
    sql += ' AND trigger_type = ?'
    params.push(filters.triggerType)
  }
  if (includeProviderModel && filters?.isDefaultModel !== undefined) {
    sql += ' AND is_default_model = ?'
    params.push(filters.isDefaultModel ? 1 : 0)
  }
  if (includeProviderModel && filters?.provider) {
    sql += ' AND provider = ?'
    params.push(filters.provider)
  }
  if (includeProviderModel && filters?.model) {
    sql += ' AND model = ?'
    params.push(filters.model)
  }
  if (filters?.createdFrom) {
    sql += ' AND created_at >= ?'
    params.push(filters.createdFrom)
  }
  if (filters?.createdTo) {
    sql += ' AND created_at <= ?'
    params.push(filters.createdTo)
  }

  return { sql, params }
}

// Raw row from SQLite
interface TaskRow {
  id: string
  name: string
  prompt: string
  status: string
  trigger_type: string
  trigger_source_id: string | null
  provider: string | null
  model: string | null
  is_default_model: number | null
  thinking_level: string | null
  effective_thinking_level: string | null
  max_duration_minutes: number | null
  prompt_tokens: number
  completion_tokens: number
  cache_read: number
  cache_write: number
  estimated_cost: number
  tool_call_count: number
  result_summary: string | null
  result_status: string | null
  error_message: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
  session_id: string | null
  owner_user_id: number | null
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    status: row.status as TaskStatus,
    triggerType: row.trigger_type as TaskTriggerType,
    triggerSourceId: row.trigger_source_id,
    provider: row.provider,
    model: row.model,
    isDefaultModel:
      row.is_default_model === null || row.is_default_model === undefined
        ? null
        : row.is_default_model === 1,
    thinkingLevel: normalizeThinkingLevel(row.thinking_level) ?? null,
    effectiveThinkingLevel: normalizeThinkingLevel(row.effective_thinking_level) ?? null,
    maxDurationMinutes: row.max_duration_minutes,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    cacheRead: row.cache_read,
    cacheWrite: row.cache_write,
    estimatedCost: row.estimated_cost,
    toolCallCount: row.tool_call_count,
    resultSummary: row.result_summary,
    resultStatus: row.result_status as TaskResultStatus | null,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    sessionId: row.session_id,
    ownerUserId: row.owner_user_id ?? null,
  }
}

/**
 * Initialize the tasks table in the database
 */
export function initTasksTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('running', 'paused', 'completed', 'failed')),
      trigger_type TEXT NOT NULL CHECK(trigger_type IN ('user', 'agent', 'cronjob', 'heartbeat', 'consolidation')),
      trigger_source_id TEXT,
      provider TEXT,
      model TEXT,
      is_default_model INTEGER,
      thinking_level TEXT,
      effective_thinking_level TEXT,
      max_duration_minutes INTEGER,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read INTEGER NOT NULL DEFAULT 0,
      cache_write INTEGER NOT NULL DEFAULT 0,
      estimated_cost REAL NOT NULL DEFAULT 0.0,
      tool_call_count INTEGER NOT NULL DEFAULT 0,
      result_summary TEXT,
      result_status TEXT CHECK(result_status IS NULL OR result_status IN ('completed', 'failed', 'question', 'silent')),
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT,
      session_id TEXT,
      owner_user_id INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_trigger_type ON tasks(trigger_type);
    CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at);
    CREATE INDEX IF NOT EXISTS idx_tasks_provider_model_created_at ON tasks(provider, model, created_at);
    CREATE INDEX IF NOT EXISTS idx_tasks_model_created_at ON tasks(model, created_at);
    CREATE INDEX IF NOT EXISTS idx_tasks_is_default_model_created_at ON tasks(is_default_model, created_at);
    CREATE INDEX IF NOT EXISTS idx_tasks_session_id ON tasks(session_id);
  `)
  migrateTaskOwners(db)
}

function tableHasColumn(db: Database, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some(c => c.name === column)
}

function parseUserId(value: unknown): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : null
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim())
  return null
}

/**
 * Adds `tasks.owner_user_id` and attributes tasks without an owner to the user
 * of their session lineage, falling back to the bootstrap admin. Idempotent.
 */
export function migrateTaskOwners(db: Database): void {
  if (!tableHasColumn(db, 'tasks', 'owner_user_id')) {
    db.exec('ALTER TABLE tasks ADD COLUMN owner_user_id INTEGER')
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner_user_id)')

  const bootstrapAdminId = getBootstrapAdminId(db)
  if (bootstrapAdminId === null) return

  const orphans = db.prepare('SELECT id, session_id FROM tasks WHERE owner_user_id IS NULL').all() as Array<{
    id: string
    session_id: string | null
  }>
  if (orphans.length === 0) return

  const userExists = db.prepare('SELECT 1 FROM users WHERE id = ?')
  const sessionRow = db.prepare('SELECT parent_session_id, user_id, session_user FROM sessions WHERE id = ?')
  const setOwner = db.prepare('UPDATE tasks SET owner_user_id = ? WHERE id = ?')

  const resolveLineageOwner = (sessionId: string | null): number | null => {
    let currentId = sessionId
    for (let depth = 0; currentId && depth < 10; depth++) {
      const row = sessionRow.get(currentId) as
        | { parent_session_id: string | null; user_id: number | null; session_user: string | null }
        | undefined
      if (!row) return null
      for (const candidate of [parseUserId(row.session_user), parseUserId(row.user_id)]) {
        if (candidate !== null && userExists.get(candidate)) return candidate
      }
      currentId = row.parent_session_id
    }
    return null
  }

  db.transaction(() => {
    for (const orphan of orphans) {
      setOwner.run(resolveLineageOwner(orphan.session_id) ?? bootstrapAdminId, orphan.id)
    }
  })()
}

/**
 * Task Store — CRUD operations for the tasks table
 */
export class TaskStore {
  constructor(private db: Database) {}

  /**
   * Create a new task
   */
  create(input: CreateTaskInput): Task {
    const id = randomUUID()
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19)
    const ownerUserId = input.ownerUserId ?? getBootstrapAdminId(this.db)

    this.db.prepare(`
      INSERT INTO tasks (id, name, prompt, status, trigger_type, trigger_source_id, provider, model, is_default_model, thinking_level, max_duration_minutes, session_id, created_at, owner_user_id)
      VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.name,
      input.prompt,
      input.triggerType,
      input.triggerSourceId ?? null,
      input.provider ?? null,
      input.model ?? null,
      input.isDefaultModel === undefined ? null : (input.isDefaultModel ? 1 : 0),
      input.thinkingLevel ?? null,
      input.maxDurationMinutes ?? null,
      input.sessionId ?? null,
      now,
      ownerUserId,
    )

    return this.getById(id)!
  }

  /**
   * Get a task by ID
   */
  getById(id: string): Task | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined
    return row ? rowToTask(row) : null
  }

  /**
   * List tasks with optional filters
   */
  list(filters?: TaskListFilters): Task[] {
    let sql = 'SELECT * FROM tasks WHERE 1=1'
    const filterClause = buildTaskFilterClause(filters)
    sql += filterClause.sql
    const params = filterClause.params

    sql += ' ORDER BY created_at DESC'

    if (filters?.limit) {
      sql += ' LIMIT ?'
      params.push(filters.limit)
    }
    if (filters?.offset) {
      sql += ' OFFSET ?'
      params.push(filters.offset)
    }

    const rows = this.db.prepare(sql).all(...params) as TaskRow[]
    return rows.map(rowToTask)
  }

  /**
   * Update a task
   */
  update(id: string, input: UpdateTaskInput): Task | null {
    const setClauses: string[] = []
    const params: unknown[] = []

    if (input.status !== undefined) {
      setClauses.push('status = ?')
      params.push(input.status)
    }
    if (input.provider !== undefined) {
      setClauses.push('provider = ?')
      params.push(input.provider)
    }
    if (input.model !== undefined) {
      setClauses.push('model = ?')
      params.push(input.model)
    }
    if (input.effectiveThinkingLevel !== undefined) {
      setClauses.push('effective_thinking_level = ?')
      params.push(input.effectiveThinkingLevel)
    }
    if (input.promptTokens !== undefined) {
      setClauses.push('prompt_tokens = ?')
      params.push(input.promptTokens)
    }
    if (input.completionTokens !== undefined) {
      setClauses.push('completion_tokens = ?')
      params.push(input.completionTokens)
    }
    if (input.cacheRead !== undefined) {
      setClauses.push('cache_read = ?')
      params.push(input.cacheRead)
    }
    if (input.cacheWrite !== undefined) {
      setClauses.push('cache_write = ?')
      params.push(input.cacheWrite)
    }
    if (input.estimatedCost !== undefined) {
      setClauses.push('estimated_cost = ?')
      params.push(input.estimatedCost)
    }
    if (input.toolCallCount !== undefined) {
      setClauses.push('tool_call_count = ?')
      params.push(input.toolCallCount)
    }
    if (input.resultSummary !== undefined) {
      setClauses.push('result_summary = ?')
      params.push(input.resultSummary)
    }
    if (input.resultStatus !== undefined) {
      setClauses.push('result_status = ?')
      params.push(input.resultStatus)
    }
    if (input.errorMessage !== undefined) {
      setClauses.push('error_message = ?')
      params.push(input.errorMessage)
    }
    if (input.startedAt !== undefined) {
      setClauses.push('started_at = ?')
      params.push(input.startedAt)
    }
    if (input.completedAt !== undefined) {
      setClauses.push('completed_at = ?')
      params.push(input.completedAt)
    }
    if (input.sessionId !== undefined) {
      setClauses.push('session_id = ?')
      params.push(input.sessionId)
    }

    if (setClauses.length === 0) return this.getById(id)

    params.push(id)
    this.db.prepare(`UPDATE tasks SET ${setClauses.join(', ')} WHERE id = ?`).run(...params)

    return this.getById(id)
  }

  /**
   * Delete a task
   */
  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id)
    return result.changes > 0
  }
}
