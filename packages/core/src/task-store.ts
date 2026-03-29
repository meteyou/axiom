import { randomUUID } from 'node:crypto'
import type { Database } from './database.js'

export type TaskStatus = 'running' | 'paused' | 'completed' | 'failed'
export type TaskTriggerType = 'user' | 'agent' | 'cronjob'
export type TaskResultStatus = 'completed' | 'failed' | 'question'

export interface Task {
  id: string
  name: string
  prompt: string
  status: TaskStatus
  triggerType: TaskTriggerType
  triggerSourceId: string | null
  provider: string | null
  model: string | null
  maxDurationMinutes: number | null
  promptTokens: number
  completionTokens: number
  estimatedCost: number
  toolCallCount: number
  resultSummary: string | null
  resultStatus: TaskResultStatus | null
  errorMessage: string | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  sessionId: string | null
}

export interface CreateTaskInput {
  name: string
  prompt: string
  triggerType: TaskTriggerType
  triggerSourceId?: string
  provider?: string
  model?: string
  maxDurationMinutes?: number
  sessionId?: string
}

export interface UpdateTaskInput {
  status?: TaskStatus
  provider?: string
  model?: string
  promptTokens?: number
  completionTokens?: number
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
  status?: TaskStatus
  triggerType?: TaskTriggerType
  limit?: number
  offset?: number
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
  max_duration_minutes: number | null
  prompt_tokens: number
  completion_tokens: number
  estimated_cost: number
  tool_call_count: number
  result_summary: string | null
  result_status: string | null
  error_message: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
  session_id: string | null
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
    maxDurationMinutes: row.max_duration_minutes,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    estimatedCost: row.estimated_cost,
    toolCallCount: row.tool_call_count,
    resultSummary: row.result_summary,
    resultStatus: row.result_status as TaskResultStatus | null,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    sessionId: row.session_id,
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
      trigger_type TEXT NOT NULL CHECK(trigger_type IN ('user', 'agent', 'cronjob')),
      trigger_source_id TEXT,
      provider TEXT,
      model TEXT,
      max_duration_minutes INTEGER,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      estimated_cost REAL NOT NULL DEFAULT 0.0,
      tool_call_count INTEGER NOT NULL DEFAULT 0,
      result_summary TEXT,
      result_status TEXT CHECK(result_status IS NULL OR result_status IN ('completed', 'failed', 'question')),
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT,
      session_id TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_trigger_type ON tasks(trigger_type);
    CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at);
    CREATE INDEX IF NOT EXISTS idx_tasks_session_id ON tasks(session_id);
  `)
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

    this.db.prepare(`
      INSERT INTO tasks (id, name, prompt, status, trigger_type, trigger_source_id, provider, model, max_duration_minutes, session_id, created_at)
      VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.name,
      input.prompt,
      input.triggerType,
      input.triggerSourceId ?? null,
      input.provider ?? null,
      input.model ?? null,
      input.maxDurationMinutes ?? null,
      input.sessionId ?? null,
      now,
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
    const params: unknown[] = []

    if (filters?.status) {
      sql += ' AND status = ?'
      params.push(filters.status)
    }
    if (filters?.triggerType) {
      sql += ' AND trigger_type = ?'
      params.push(filters.triggerType)
    }

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
    if (input.promptTokens !== undefined) {
      setClauses.push('prompt_tokens = ?')
      params.push(input.promptTokens)
    }
    if (input.completionTokens !== undefined) {
      setClauses.push('completion_tokens = ?')
      params.push(input.completionTokens)
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
