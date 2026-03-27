import type { Database } from './database.js'

export interface TokenUsageRecord {
  provider: string
  model: string
  promptTokens: number
  completionTokens: number
  estimatedCost: number
  sessionId?: string
}

export interface ToolCallRecord {
  id?: number
  timestamp?: string
  sessionId: string
  toolName: string
  input: string
  output: string
  durationMs: number
  status?: 'success' | 'error'
}

/**
 * Log token usage to the SQLite database
 */
export function logTokenUsage(db: Database, record: TokenUsageRecord): void {
  db.prepare(
    `INSERT INTO token_usage (provider, model, prompt_tokens, completion_tokens, estimated_cost, session_id)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    record.provider,
    record.model,
    record.promptTokens,
    record.completionTokens,
    record.estimatedCost,
    record.sessionId ?? null,
  )
}

/**
 * Log a tool call to the SQLite database
 */
export function logToolCall(db: Database, record: ToolCallRecord): number {
  const result = db.prepare(
    `INSERT INTO tool_calls (session_id, tool_name, input, output, duration_ms, status)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    record.sessionId,
    record.toolName,
    record.input,
    record.output,
    record.durationMs,
    record.status ?? 'success',
  )
  return Number(result.lastInsertRowid)
}

/**
 * Query token usage records from the database
 */
export function getTokenUsage(db: Database, options?: {
  provider?: string
  model?: string
  limit?: number
}): TokenUsageRecord[] {
  let sql = 'SELECT provider, model, prompt_tokens as promptTokens, completion_tokens as completionTokens, estimated_cost as estimatedCost, session_id as sessionId FROM token_usage WHERE 1=1'
  const params: unknown[] = []

  if (options?.provider) {
    sql += ' AND provider = ?'
    params.push(options.provider)
  }
  if (options?.model) {
    sql += ' AND model = ?'
    params.push(options.model)
  }

  sql += ' ORDER BY timestamp DESC'

  if (options?.limit) {
    sql += ' LIMIT ?'
    params.push(options.limit)
  }

  return db.prepare(sql).all(...params) as TokenUsageRecord[]
}

/**
 * Query tool call records from the database
 */
export interface ToolCallQueryOptions {
  sessionId?: string
  toolName?: string
  search?: string
  dateFrom?: string
  dateTo?: string
  page?: number
  limit?: number
}

export interface ToolCallQueryResult {
  records: ToolCallRecord[]
  total: number
  page: number
  limit: number
  totalPages: number
}

export function getToolCalls(db: Database, options?: {
  sessionId?: string
  toolName?: string
  limit?: number
}): ToolCallRecord[] {
  let sql = 'SELECT id, timestamp, session_id as sessionId, tool_name as toolName, input, output, duration_ms as durationMs, status FROM tool_calls WHERE 1=1'
  const params: unknown[] = []

  if (options?.sessionId) {
    sql += ' AND session_id = ?'
    params.push(options.sessionId)
  }
  if (options?.toolName) {
    sql += ' AND tool_name = ?'
    params.push(options.toolName)
  }

  sql += ' ORDER BY timestamp DESC'

  if (options?.limit) {
    sql += ' LIMIT ?'
    params.push(options.limit)
  }

  return db.prepare(sql).all(...params) as ToolCallRecord[]
}

/**
 * Query tool calls with pagination, full-text search, and date range
 */
export function queryToolCalls(db: Database, options: ToolCallQueryOptions = {}): ToolCallQueryResult {
  const page = Math.max(1, options.page ?? 1)
  const limit = Math.min(100, Math.max(1, options.limit ?? 50))
  const offset = (page - 1) * limit

  let where = 'WHERE 1=1'
  const params: unknown[] = []

  if (options.sessionId) {
    where += ' AND session_id = ?'
    params.push(options.sessionId)
  }
  if (options.toolName) {
    where += ' AND tool_name = ?'
    params.push(options.toolName)
  }
  if (options.search) {
    where += ' AND (tool_name LIKE ? OR input LIKE ? OR output LIKE ?)'
    const term = `%${options.search}%`
    params.push(term, term, term)
  }
  if (options.dateFrom) {
    where += ' AND timestamp >= ?'
    params.push(options.dateFrom)
  }
  if (options.dateTo) {
    where += ' AND timestamp <= ?'
    params.push(options.dateTo)
  }

  const total = (db.prepare(`SELECT COUNT(*) as count FROM tool_calls ${where}`).get(...params) as { count: number }).count

  const records = db.prepare(
    `SELECT id, timestamp, session_id as sessionId, tool_name as toolName, input, output, duration_ms as durationMs, status FROM tool_calls ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset) as ToolCallRecord[]

  return {
    records,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  }
}

/**
 * Get a single tool call by ID
 */
export function getToolCallById(db: Database, id: number): ToolCallRecord | null {
  const row = db.prepare(
    'SELECT id, timestamp, session_id as sessionId, tool_name as toolName, input, output, duration_ms as durationMs, status FROM tool_calls WHERE id = ?'
  ).get(id) as ToolCallRecord | undefined
  return row ?? null
}

/**
 * Get distinct tool names for filter dropdown
 */
export function getDistinctToolNames(db: Database): string[] {
  const rows = db.prepare('SELECT DISTINCT tool_name FROM tool_calls ORDER BY tool_name').all() as { tool_name: string }[]
  return rows.map(r => r.tool_name)
}
