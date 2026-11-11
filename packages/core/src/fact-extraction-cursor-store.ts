import type { Database } from './database.js'

/**
 * One row per session whose transcript was (partly) run through fact
 * extraction. No foreign key: like `context_compactions`, the cursor is
 * bookkeeping that must not block session or user cleanup.
 * `failed_attempts` counts consecutive failures of the chunk right after the
 * cursor, `failed_through_message_id` is where the last failed chunk ended.
 * Both are reset whenever the cursor moves.
 */
export function initFactExtractionCursorsTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS fact_extraction_cursors (
      session_id TEXT PRIMARY KEY,
      last_message_id INTEGER NOT NULL,
      failed_attempts INTEGER NOT NULL DEFAULT 0,
      failed_through_message_id INTEGER,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)
}

export interface FactExtractionCursorState {
  lastMessageId: number
  failedAttempts: number
  failedThroughMessageId: number | null
}

export function getFactExtractionCursorState(db: Database, sessionId: string): FactExtractionCursorState {
  const row = db.prepare(
    'SELECT last_message_id, failed_attempts, failed_through_message_id FROM fact_extraction_cursors WHERE session_id = ?'
  ).get(sessionId) as { last_message_id: number; failed_attempts: number; failed_through_message_id: number | null } | undefined
  return {
    lastMessageId: row?.last_message_id ?? 0,
    failedAttempts: row?.failed_attempts ?? 0,
    failedThroughMessageId: row?.failed_through_message_id ?? null,
  }
}

export function getFactExtractionCursor(db: Database, sessionId: string): number {
  return getFactExtractionCursorState(db, sessionId).lastMessageId
}

export function advanceFactExtractionCursor(db: Database, sessionId: string, lastMessageId: number): void {
  db.prepare(`
    INSERT INTO fact_extraction_cursors (session_id, last_message_id) VALUES (?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      last_message_id = MAX(last_message_id, excluded.last_message_id),
      failed_attempts = 0,
      failed_through_message_id = NULL,
      updated_at = datetime('now')
  `).run(sessionId, lastMessageId)
}

export function recordFactExtractionFailure(db: Database, sessionId: string, failedThroughMessageId: number): void {
  db.prepare(`
    INSERT INTO fact_extraction_cursors (session_id, last_message_id, failed_attempts, failed_through_message_id)
    VALUES (?, 0, 1, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      failed_attempts = failed_attempts + 1,
      failed_through_message_id = excluded.failed_through_message_id,
      updated_at = datetime('now')
  `).run(sessionId, failedThroughMessageId)
}
