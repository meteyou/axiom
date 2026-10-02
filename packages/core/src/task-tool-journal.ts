import type { Database } from './database.js'
import type { ToolReplayPolicy } from './tool-replay.js'

export type ToolJournalStatus = 'started' | 'completed' | 'error'

export interface ToolJournalEntry {
  toolCallId: string
  toolName: string
  args: string | null
  status: ToolJournalStatus
  result: string | null
  replay: ToolReplayPolicy | null
  startedAt: string
  endedAt: string | null
}

export interface ToolCallStartedInput {
  taskId: string
  sessionId: string | null
  toolCallId: string
  toolName: string
  args: unknown
  replay: ToolReplayPolicy
}

export interface ToolCallEndedInput {
  taskId: string
  toolCallId: string
  isError: boolean
  result: unknown
}

export const MAX_JOURNAL_FIELD_CHARS = 8 * 1024

interface ToolJournalRow {
  tool_call_id: string
  tool_name: string
  args: string | null
  status: ToolJournalStatus
  result: string | null
  replay: ToolReplayPolicy | null
  started_at: string
  ended_at: string | null
}

/**
 * Deliberately has no foreign key to `tasks`: the `tasks` table is rebuilt via
 * RENAME/CREATE/DROP migrations, which would break or rewrite such a reference.
 * Rows of finished or deleted tasks are removed by `pruneFinishedTasks()`.
 */
export function initTaskToolJournalTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_tool_journal (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      session_id TEXT,
      tool_call_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      args TEXT,
      status TEXT NOT NULL CHECK(status IN ('started', 'completed', 'error')),
      result TEXT,
      replay TEXT CHECK(replay IN ('safe', 'unsafe')),
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT,
      UNIQUE(task_id, tool_call_id)
    );

    CREATE INDEX IF NOT EXISTS idx_task_tool_journal_task ON task_tool_journal(task_id);
  `)
}

export function truncateJournalText(text: string, maxChars: number = MAX_JOURNAL_FIELD_CHARS): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}… [truncated ${text.length - maxChars} chars]`
}

function serializeForJournal(value: unknown): string {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value ?? {})
  return truncateJournalText(serialized ?? '')
}

function hasContentArray(value: unknown): value is { content: unknown[] } {
  return typeof value === 'object' && value !== null && Array.isArray((value as { content?: unknown }).content)
}

function formatToolResultForJournal(result: unknown): string {
  if (!hasContentArray(result)) return serializeForJournal(result)

  const modelFacingText = result.content
    .map(part => {
      const typed = part as { type?: string; text?: string }
      if (typed.type === 'text') return typed.text ?? ''
      return `[${typed.type ?? 'unknown'}]`
    })
    .join('\n')
  return truncateJournalText(modelFacingText)
}

/**
 * Write-ahead record of background-task tool calls. A row is written before a
 * tool runs and finalized when it ends, so a row still in `started` after a
 * crash marks a call whose outcome is unknown.
 */
export class TaskToolJournal {
  constructor(private readonly db: Database) {}

  recordStarted(input: ToolCallStartedInput): void {
    // Tool call ids are provider-generated and not guaranteed to be unique
    // across a whole task; on a collision the latest call replaces the old row
    // instead of the insert failing.
    this.db.prepare(`
      INSERT OR REPLACE INTO task_tool_journal (task_id, session_id, tool_call_id, tool_name, args, status, replay)
      VALUES (?, ?, ?, ?, ?, 'started', ?)
    `).run(input.taskId, input.sessionId, input.toolCallId, input.toolName, serializeForJournal(input.args), input.replay)
  }

  recordEnded(input: ToolCallEndedInput): void {
    this.db.prepare(`
      UPDATE task_tool_journal
      SET status = ?, result = ?, ended_at = datetime('now')
      WHERE task_id = ? AND tool_call_id = ?
    `).run(input.isError ? 'error' : 'completed', formatToolResultForJournal(input.result), input.taskId, input.toolCallId)
  }

  listForTask(taskId: string): ToolJournalEntry[] {
    const rows = this.db.prepare(`
      SELECT tool_call_id, tool_name, args, status, result, replay, started_at, ended_at
      FROM task_tool_journal
      WHERE task_id = ?
      ORDER BY id ASC
    `).all(taskId) as ToolJournalRow[]

    return rows.map(row => ({
      toolCallId: row.tool_call_id,
      toolName: row.tool_name,
      args: row.args,
      status: row.status,
      result: row.result,
      replay: row.replay,
      startedAt: row.started_at,
      endedAt: row.ended_at,
    }))
  }

  /**
   * The journal only matters while a task can still be recovered, so rows of
   * tasks that are no longer running/paused (or no longer exist) are dropped.
   */
  pruneFinishedTasks(): number {
    const result = this.db.prepare(`
      DELETE FROM task_tool_journal
      WHERE task_id NOT IN (SELECT id FROM tasks WHERE status IN ('running', 'paused'))
    `).run()
    return result.changes
  }
}
