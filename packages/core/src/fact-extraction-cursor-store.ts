import type { Database } from './database.js'

/**
 * One row per session whose transcript was (partly) run through fact
 * extraction. No foreign key: like `context_compactions`, the cursor is
 * bookkeeping that must not block session or user cleanup.
 */
export function initFactExtractionCursorsTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS fact_extraction_cursors (
      session_id TEXT PRIMARY KEY,
      last_message_id INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)
}

export function getFactExtractionCursor(db: Database, sessionId: string): number {
  const row = db.prepare(
    'SELECT last_message_id FROM fact_extraction_cursors WHERE session_id = ?'
  ).get(sessionId) as { last_message_id: number } | undefined
  return row?.last_message_id ?? 0
}

export function advanceFactExtractionCursor(db: Database, sessionId: string, lastMessageId: number): void {
  db.prepare(`
    INSERT INTO fact_extraction_cursors (session_id, last_message_id) VALUES (?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      last_message_id = MAX(last_message_id, excluded.last_message_id),
      updated_at = datetime('now')
  `).run(sessionId, lastMessageId)
}
