import type { Database } from './database.js'
import type { CompactionReason, CompactionScope } from './compaction.js'

export interface ContextCompactionRecord {
  id?: number
  sessionId: string | null
  scope: CompactionScope
  reason: CompactionReason
  provider: string
  model: string
  tokensBefore: number
  tokensAfter: number
  summary: string
  /** Timestamp (ms) of the first message kept verbatim; null when nothing was kept. */
  firstKeptTimestamp: number | null
  promptTokens: number
  completionTokens: number
  cacheRead: number
  cacheWrite: number
  estimatedCost: number
  createdAt?: string
}

interface ContextCompactionRow {
  id: number
  session_id: string | null
  created_at: string
  scope: CompactionScope
  reason: CompactionReason
  provider: string
  model: string
  tokens_before: number
  tokens_after: number
  summary: string
  first_kept_timestamp: number | null
  prompt_tokens: number
  completion_tokens: number
  cache_read: number
  cache_write: number
  estimated_cost: number
}

/**
 * Keeps every summary, so a later restart (or an audit) can see what the model
 * was left with. No foreign key to `sessions`: compactions must survive
 * session cleanup the same way `token_usage` rows do.
 */
export function initContextCompactionsTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS context_compactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      scope TEXT NOT NULL CHECK(scope IN ('interactive', 'task')),
      reason TEXT NOT NULL CHECK(reason IN ('threshold', 'overflow', 'manual')),
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      tokens_before INTEGER NOT NULL,
      tokens_after INTEGER NOT NULL,
      summary TEXT NOT NULL,
      first_kept_timestamp INTEGER,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read INTEGER NOT NULL DEFAULT 0,
      cache_write INTEGER NOT NULL DEFAULT 0,
      estimated_cost REAL NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_context_compactions_session ON context_compactions(session_id, created_at);
  `)
}

export function saveContextCompaction(db: Database, record: ContextCompactionRecord): number {
  const result = db.prepare(`
    INSERT INTO context_compactions (
      session_id, scope, reason, provider, model, tokens_before, tokens_after, summary,
      first_kept_timestamp, prompt_tokens, completion_tokens, cache_read, cache_write, estimated_cost
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.sessionId,
    record.scope,
    record.reason,
    record.provider,
    record.model,
    record.tokensBefore,
    record.tokensAfter,
    record.summary,
    record.firstKeptTimestamp,
    record.promptTokens,
    record.completionTokens,
    record.cacheRead,
    record.cacheWrite,
    record.estimatedCost,
  )
  return Number(result.lastInsertRowid)
}

export function listContextCompactions(db: Database, sessionId: string): ContextCompactionRecord[] {
  const rows = db.prepare(
    'SELECT * FROM context_compactions WHERE session_id = ? ORDER BY id ASC',
  ).all(sessionId) as ContextCompactionRow[]
  return rows.map(row => ({
    id: row.id,
    sessionId: row.session_id,
    scope: row.scope,
    reason: row.reason,
    provider: row.provider,
    model: row.model,
    tokensBefore: row.tokens_before,
    tokensAfter: row.tokens_after,
    summary: row.summary,
    firstKeptTimestamp: row.first_kept_timestamp,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    cacheRead: row.cache_read,
    cacheWrite: row.cache_write,
    estimatedCost: row.estimated_cost,
    createdAt: row.created_at,
  }))
}
