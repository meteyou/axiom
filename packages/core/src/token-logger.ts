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
  sessionId: string
  toolName: string
  input: string
  output: string
  durationMs: number
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
export function logToolCall(db: Database, record: ToolCallRecord): void {
  db.prepare(
    `INSERT INTO tool_calls (session_id, tool_name, input, output, duration_ms)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    record.sessionId,
    record.toolName,
    record.input,
    record.output,
    record.durationMs,
  )
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
export function getToolCalls(db: Database, options?: {
  sessionId?: string
  toolName?: string
  limit?: number
}): ToolCallRecord[] {
  let sql = 'SELECT session_id as sessionId, tool_name as toolName, input, output, duration_ms as durationMs FROM tool_calls WHERE 1=1'
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
