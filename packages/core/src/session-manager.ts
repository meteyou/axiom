import { randomUUID } from 'node:crypto'
import type { Database } from './database.js'
import { appendToDailyFile } from './memory.js'
import { logToolCall } from './token-logger.js'

/**
 * The single canonical session ID generator. All new sessions — interactive,
 * task, heartbeat, consolidation, loop_detection — must obtain their ID from
 * this function so that ID format is uniform across the system.
 */
export function generateSessionId(): string {
  return randomUUID()
}

export type SessionType =
  | 'interactive'
  | 'task'
  | 'heartbeat'
  | 'consolidation'
  | 'loop_detection'

export interface CreateSessionOptions {
  type: SessionType
  source: string
  userId?: string
  parentSessionId?: string
}

export interface SessionInfo {
  id: string
  userId: string
  source: string
  startedAt: number // timestamp ms
  lastActivity: number // timestamp ms
  messageCount: number
  summaryWritten: boolean
  /** True if this session was restored from DB after a server restart */
  restored: boolean
}

export interface SessionManagerOptions {
  db: Database
  timeoutMinutes?: number
  memoryDir?: string
  /**
   * Called to generate a summary of the session. Returns the summary text.
   * conversationHistory is built from chat_messages in the DB (single source of truth).
   */
  onSummarize?: (sessionId: string, userId: string, conversationHistory?: string) => Promise<string>
  /** Called when a session is disposed (after summary if applicable) */
  onSessionEnd?: (session: SessionInfo, summary: string | null) => void
}

export type SessionEndReason = 'timeout' | 'manual' | 'provider_change'

/**
 * Manages active sessions per user with timeout and auto-summarization.
 *
 * After constructing, call `init()` to handle orphaned sessions from
 * a previous server run (restore or summarize them).
 */
export class SessionManager {
  private sessions: Map<string, SessionInfo> = new Map() // userId -> session
  private timers: Map<string, ReturnType<typeof setTimeout>> = new Map() // userId -> timeout timer
  private db: Database
  private timeoutMs: number
  private memoryDir?: string
  private onSummarize?: (sessionId: string, userId: string, conversationHistory?: string) => Promise<string>
  private onSessionEnd?: (session: SessionInfo, summary: string | null) => void

  constructor(options: SessionManagerOptions) {
    this.db = options.db
    this.timeoutMs = (options.timeoutMinutes ?? 15) * 60 * 1000
    this.memoryDir = options.memoryDir
    this.onSummarize = options.onSummarize
    this.onSessionEnd = options.onSessionEnd
  }

  /**
   * Initialize the session manager. Must be called after construction.
   * Handles orphaned sessions from a previous server run:
   * - Sessions whose timeout has elapsed → summarize and close
   * - Sessions whose timeout has NOT elapsed → restore with remaining timer
   */
  async init(): Promise<void> {
    await this.handleOrphanedSessions()
  }

  /**
   * Handle sessions left open from a previous server run.
   */
  private async handleOrphanedSessions(): Promise<void> {
    // Only interactive sessions go through the inactivity-timeout / summarize
    // lifecycle. Background session types (task, heartbeat, consolidation,
    // loop_detection) are owned by their respective producers and must not be
    // auto-summarized or auto-closed by SessionManager on startup.
    const orphaned = this.db.prepare(
      `SELECT id, user_id, session_user, source, type, started_at, last_activity, message_count, summary_written
       FROM sessions WHERE ended_at IS NULL AND type = 'interactive'`
    ).all() as Array<{
      id: string
      user_id: number | null
      session_user: string | null
      source: string
      type: string
      started_at: string
      last_activity: string | null
      message_count: number
      summary_written: number
    }>

    if (orphaned.length === 0) return

    // Guard: a SessionManager without `onSummarize` is not configured to
    // manage the interactive-session lifecycle. If an orphan would hit the
    // summarize-and-close path and we proceeded without an onSummarize
    // handler, we would silently close it and lose the daily-file summary
    // — the exact failure mode that makes a mis-routed init() call
    // invisible (see runtime-composition.ts's background-only
    // SessionManager). Fail fast so misuse surfaces immediately.
    //
    // Only orphans whose timeout has already elapsed AND still carry
    // unsummarized messages are at risk. Orphans within the timeout window
    // are restored, and empty/already-summarized ones are closed
    // losslessly, so neither requires onSummarize.
    if (!this.onSummarize) {
      const now = Date.now()
      const needsSummary = orphaned.filter(r => {
        if (r.summary_written || r.message_count === 0) return false
        const lastActivityStr = r.last_activity ?? r.started_at
        const lastActivity = this.parseSqliteTimestamp(lastActivityStr)
        return (now - lastActivity) >= this.timeoutMs
      })
      if (needsSummary.length > 0) {
        throw new Error(
          `[session] ${needsSummary.length} orphaned interactive session(s) need summarization `
          + `but SessionManager was constructed without an onSummarize handler. `
          + `This instance is not configured to manage the interactive-session lifecycle; `
          + `do not call init() on it.`,
        )
      }
    }

    console.log(`[session] Found ${orphaned.length} orphaned session(s) from previous run`)

    for (const row of orphaned) {
      // Determine last activity time (fall back to started_at for pre-migration sessions)
      const lastActivityStr = row.last_activity ?? row.started_at
      const lastActivity = this.parseSqliteTimestamp(lastActivityStr)
      const elapsed = Date.now() - lastActivity

      // Prefer numeric user_id when present (stable canonical key), then
      // fall back to session_user for rows without user_id (e.g. legacy /
      // non-numeric identities). Final fallback keeps sessions distinct.
      const userId = row.user_id != null
        ? String(row.user_id)
        : (row.session_user ?? `orphan:${row.id}`)

      if (elapsed >= this.timeoutMs) {
        // Timeout already elapsed → summarize and close
        await this.summarizeAndCloseOrphanedSession(row, userId, lastActivity)
      } else {
        // Timeout not yet elapsed → restore session with remaining time
        this.restoreSession(row, userId, lastActivity, this.timeoutMs - elapsed)
      }
    }
  }

  /**
   * Parse a SQLite datetime string to a timestamp in ms.
   * SQLite stores as 'YYYY-MM-DD HH:MM:SS' in UTC without timezone marker.
   */
  private parseSqliteTimestamp(str: string): number {
    // Append 'Z' to treat as UTC if no timezone info present
    const normalized = str.includes('Z') || str.includes('+') ? str : str + 'Z'
    return new Date(normalized).getTime()
  }

  /**
   * Summarize an orphaned session that has already timed out, then close it.
   * Uses the lastActivity timestamp to write to the correct daily file.
   */
  private async summarizeAndCloseOrphanedSession(
    row: { id: string; started_at: string; message_count: number; summary_written: number; source: string },
    userId: string,
    lastActivity: number,
  ): Promise<void> {
    let summary: string | null = null
    let summaryWritten = !!row.summary_written
    const startedAt = this.parseSqliteTimestamp(row.started_at)

    if (row.message_count > 0 && !summaryWritten && this.onSummarize) {
      try {
        const history = this.buildConversationHistory(row.id)
        if (history) {
          summary = await this.onSummarize(row.id, userId, history)
          if (summary) {
            this.writeSummaryToDailyFile(summary, lastActivity)
            summaryWritten = true
            console.log(`[session] Summary written for orphaned session ${row.id} (at ${new Date(lastActivity).toISOString()})`)
          }
        }
      } catch (err) {
        console.error(`[session] Failed to summarize orphaned session ${row.id}:`, err)
      }
    }

    // Close session in DB
    this.db.prepare(
      `UPDATE sessions SET ended_at = datetime('now'), summary_written = ? WHERE id = ?`
    ).run(summaryWritten ? 1 : 0, row.id)

    // Log to tool_calls for activity log visibility
    logToolCall(this.db, {
      sessionId: row.id,
      toolName: 'session_timeout',
      input: JSON.stringify({
        reason: 'server_restart',
        messageCount: row.message_count,
      }),
      output: JSON.stringify({
        summaryWritten,
        summary,
        note: summary
          ? 'Orphaned session summarized on startup'
          : 'Session closed due to server restart',
      }),
      durationMs: 0,
      status: 'success',
    })

    if (this.onSessionEnd) {
      this.onSessionEnd({
        id: row.id,
        userId,
        source: row.source,
        startedAt,
        lastActivity,
        messageCount: row.message_count,
        summaryWritten,
        restored: true,
      }, summary)
    }
  }

  /**
   * Restore an orphaned session whose timeout has not yet elapsed.
   * Recreates the in-memory session and starts a timer with the remaining time.
   */
  private restoreSession(
    row: {
      id: string
      source: string
      started_at: string
      message_count: number
      summary_written: number
    },
    userId: string,
    lastActivity: number,
    remainingMs: number,
  ): void {
    const startedAt = this.parseSqliteTimestamp(row.started_at)

    const session: SessionInfo = {
      id: row.id,
      userId,
      source: row.source,
      startedAt,
      lastActivity,
      messageCount: row.message_count,
      summaryWritten: !!row.summary_written,
      restored: true,
    }

    this.sessions.set(userId, session)

    const remainingMinutes = Math.round(remainingMs / 60000)
    console.log(`[session] Restored session ${row.id} for user ${userId} (${remainingMinutes}min remaining)`)

    // Start timer with remaining time
    const timer = setTimeout(() => {
      console.log(`[session] Timeout fired for restored session of user ${userId}`)
      this.endSession(userId).catch(err => {
        console.error(`[session] Timeout error for user ${userId}:`, err)
      })
    }, remainingMs)

    if (typeof timer === 'object' && 'unref' in timer) {
      timer.unref()
    }

    this.timers.set(userId, timer)
  }

  /**
   * Write a summary to the daily memory file at the given timestamp.
   */
  private writeSummaryToDailyFile(summary: string, timestamp: number): void {
    const activityDate = new Date(timestamp)
    const hh = String(activityDate.getHours()).padStart(2, '0')
    const mm = String(activityDate.getMinutes()).padStart(2, '0')
    const formattedSummary = `\n## ${hh}:${mm}\n\n${summary}\n`
    appendToDailyFile(formattedSummary, activityDate, this.memoryDir)
  }

  /**
   * Build a conversation history string from chat_messages in the DB.
   *
   * Includes:
   * - All messages in the given session
   * - All messages in descendant sessions (children, grandchildren, ...)
   *   linked via `sessions.parent_session_id`
   *
   * This subsumes the previous time-window heuristic for pulling in task
   * result notifications and task injection responses: those messages now
   * live in child/task sessions (or — when merged — in this session
   * directly via `processTaskInjection`).
   */
  buildConversationHistory(sessionId: string): string | null {
    type ChatMessageRow = {
      session_id: string
      role: string
      content: string
      metadata: string | null
      timestamp: string
    }

    // Recursive CTE: include the session itself + all descendants via
    // parent_session_id (task, loop_detection, etc.). Use UNION (distinct)
    // so accidental cycles in parent_session_id cannot recurse forever.
    const messages = this.db.prepare(
      `WITH RECURSIVE session_tree(id) AS (
         SELECT ?
         UNION
         SELECT s.id FROM sessions s
         JOIN session_tree st ON s.parent_session_id = st.id
       )
       SELECT session_id, role, content, metadata, timestamp
       FROM chat_messages
       WHERE session_id IN (SELECT id FROM session_tree)
       ORDER BY timestamp ASC`
    ).all(sessionId) as ChatMessageRow[]

    if (messages.length === 0) return null

    const lines: string[] = []
    for (const msg of messages) {
      let metadata: Record<string, unknown> | null = null
      try {
        metadata = msg.metadata ? JSON.parse(msg.metadata) as Record<string, unknown> : null
      } catch {
        metadata = null
      }

      if (msg.role === 'user') {
        lines.push(`User: ${msg.content}`)
      } else if (msg.role === 'assistant') {
        if (metadata?.type === 'task_injection_response') {
          lines.push(`Assistant (task update): ${msg.content.slice(0, 2000)}`)
        } else {
          lines.push(`Assistant: ${msg.content.slice(0, 2000)}`)
        }
      } else if (msg.role === 'system' && metadata?.type === 'task_result') {
        const taskStatus = typeof metadata.taskResultStatus === 'string'
          ? metadata.taskResultStatus
          : typeof metadata.taskStatus === 'string'
            ? metadata.taskStatus
            : 'completed'
        const taskName = typeof metadata.taskName === 'string' ? metadata.taskName.trim() : ''
        const taskLabel = taskName ? `: ${taskName}` : ''
        lines.push(`Background task (${taskStatus}${taskLabel}): ${msg.content.slice(0, 2000)}`)
      }
    }

    const text = lines.join('\n').slice(0, 12000)
    return text || null
  }

  /**
   * Update the timeout duration (in minutes)
   */
  setTimeoutMinutes(minutes: number): void {
    this.timeoutMs = minutes * 60 * 1000
  }

  /**
   * Get or create an interactive session for a user. Resets the inactivity
   * timer. Always creates sessions with `type='interactive'` — background
   * session types (task, heartbeat, consolidation, loop_detection) must use
   * `createSession()` instead so they are not cached per-user and do not
   * occupy the interactive-session lifecycle slot.
   */
  getOrCreateSession(userId: string, source: string = 'web'): SessionInfo {
    let session = this.sessions.get(userId)

    if (!session) {
      const id = generateSessionId()
      session = {
        id,
        userId,
        source,
        startedAt: Date.now(),
        lastActivity: Date.now(),
        messageCount: 0,
        summaryWritten: false,
        restored: false,
      }
      this.sessions.set(userId, session)

      // Insert into SQLite (type is hardcoded to 'interactive'; see method
      // docstring for rationale).
      this.db.prepare(
        `INSERT INTO sessions (id, user_id, source, type, parent_session_id, started_at, last_activity, session_user, message_count, summary_written)
         VALUES (?, ?, ?, 'interactive', NULL, datetime(? / 1000, 'unixepoch'), datetime(? / 1000, 'unixepoch'), ?, 0, 0)`
      ).run(session.id, null, source, session.startedAt, session.lastActivity, userId)

      // Log session start to tool_calls for activity log visibility
      logToolCall(this.db, {
        sessionId: session.id,
        toolName: 'session_start',
        input: JSON.stringify({ userId, source }),
        output: JSON.stringify({ sessionId: session.id }),
        durationMs: 0,
        status: 'success',
      })

      // Start inactivity timer for the new session
      this.resetTimer(userId)
    }

    return session
  }

  /**
   * Create a non-interactive session (task, heartbeat, consolidation,
   * loop_detection). Unlike `getOrCreateSession`, this does NOT cache the
   * session per-user and does NOT start an inactivity timer — background
   * sessions are owned and closed by their producers.
   */
  createSession(options: CreateSessionOptions): SessionInfo {
    const id = generateSessionId()
    const now = Date.now()
    const session: SessionInfo = {
      id,
      userId: options.userId ?? 'system',
      source: options.source,
      startedAt: now,
      lastActivity: now,
      messageCount: 0,
      summaryWritten: false,
      restored: false,
    }

    this.db.prepare(
      `INSERT INTO sessions (id, user_id, source, type, parent_session_id, started_at, last_activity, session_user, message_count, summary_written)
       VALUES (?, NULL, ?, ?, ?, datetime(? / 1000, 'unixepoch'), datetime(? / 1000, 'unixepoch'), ?, 0, 0)`
    ).run(
      id,
      options.source,
      options.type,
      options.parentSessionId ?? null,
      now,
      now,
      options.userId ?? null,
    )

    return session
  }

  /**
   * Record a message in the active session
   */
  recordMessage(userId: string): void {
    const session = this.sessions.get(userId)
    if (session) {
      session.messageCount++
      session.lastActivity = Date.now()
      this.resetTimer(userId)

      // Update SQLite (message count and last activity)
      this.db.prepare(
        `UPDATE sessions SET message_count = ?, last_activity = datetime(? / 1000, 'unixepoch') WHERE id = ?`
      ).run(session.messageCount, session.lastActivity, session.id)
    }
  }

  /**
   * Get the active session for a user (without creating one)
   */
  getSession(userId: string): SessionInfo | undefined {
    return this.sessions.get(userId)
  }

  /**
   * Check if a user has an active session
   */
  hasActiveSession(userId: string): boolean {
    return this.sessions.has(userId)
  }

  /**
   * Handle /new command: immediately summarize and reset
   */
  async handleNewCommand(userId: string): Promise<string | null> {
    const session = this.sessions.get(userId)
    if (!session) {
      return null
    }

    return this.endSession(userId, 'manual')
  }

  /**
   * End a session: summarize and dispose.
   * Always uses session.lastActivity as the timestamp for the daily file entry.
   */
  private async endSession(userId: string, reason: SessionEndReason = 'timeout'): Promise<string | null> {
    const session = this.sessions.get(userId)
    if (!session) {
      console.log(`[session] endSession called for user ${userId} but no active session found`)
      return null
    }

    console.log(`[session] Ending session ${session.id} for user ${userId} (${session.messageCount} messages)`)

    // Clear the timeout timer
    this.clearTimer(userId)

    let summary: string | null = null

    // Generate summary if there were messages and a summarizer is configured
    if (session.messageCount > 0 && this.onSummarize) {
      try {
        // Build conversation history from DB (single source of truth).
        // In-memory agent messages are unreliable (lost on provider change, restart, etc.)
        const history = this.buildConversationHistory(session.id) ?? undefined

        summary = await this.onSummarize(session.id, userId, history)
        if (summary) {
          this.writeSummaryToDailyFile(summary, session.lastActivity)
          session.summaryWritten = true
          console.log(`[session] Summary written to daily log for session ${session.id}`)
        }
      } catch (err) {
        console.error('[session] Failed to generate session summary:', err)
      }
    } else {
      console.log(`[session] Skipping summary: messageCount=${session.messageCount}, onSummarize=${!!this.onSummarize}`)
    }

    // Update SQLite with end time and summary flag
    this.db.prepare(
      `UPDATE sessions SET ended_at = datetime('now'), message_count = ?, summary_written = ? WHERE id = ?`
    ).run(session.messageCount, session.summaryWritten ? 1 : 0, session.id)

    // Log session end to tool_calls for activity log visibility
    const durationMs = Date.now() - session.startedAt
    logToolCall(this.db, {
      sessionId: session.id,
      toolName: reason === 'timeout' ? 'session_timeout' : 'session_end',
      input: JSON.stringify({
        userId,
        reason,
        messageCount: session.messageCount,
        durationMinutes: Math.round(durationMs / 60000),
      }),
      output: JSON.stringify({
        summaryWritten: session.summaryWritten,
        summary: summary ?? null,
      }),
      durationMs,
      status: 'success',
    })

    // Notify listener
    if (this.onSessionEnd) {
      this.onSessionEnd(session, summary)
    }

    // Remove from active sessions
    this.sessions.delete(userId)

    return summary
  }

  /**
   * End all active sessions.
   */
  async endAllSessions(reason: Exclude<SessionEndReason, 'timeout'> = 'manual'): Promise<void> {
    const userIds = Array.from(this.sessions.keys())
    for (const userId of userIds) {
      await this.endSession(userId, reason)
    }
  }

  /**
   * Reset the inactivity timer for a user
   */
  private resetTimer(userId: string): void {
    this.clearTimer(userId)

    if (this.timeoutMs <= 0) return

    const timeoutMinutes = Math.round(this.timeoutMs / 60000)
    console.log(`[session] Timer set for user ${userId}: ${timeoutMinutes}min (${this.timeoutMs}ms)`)

    const timer = setTimeout(() => {
      console.log(`[session] Timeout fired for user ${userId} — ending session`)
      this.endSession(userId).catch(err => {
        console.error(`[session] Timeout error for user ${userId}:`, err)
      })
    }, this.timeoutMs)

    // Unref so it doesn't keep the process alive
    if (typeof timer === 'object' && 'unref' in timer) {
      timer.unref()
    }

    this.timers.set(userId, timer)
  }

  /**
   * Clear the timeout timer for a user
   */
  private clearTimer(userId: string): void {
    const existing = this.timers.get(userId)
    if (existing) {
      clearTimeout(existing)
      this.timers.delete(userId)
    }
  }

  /**
   * Dispose all sessions and timers (for shutdown)
   */
  async dispose(): Promise<void> {
    for (const [userId] of this.timers) {
      this.clearTimer(userId)
    }

    // End all active sessions without summarizing
    for (const [, session] of this.sessions) {
      this.db.prepare(
        `UPDATE sessions SET ended_at = datetime('now'), message_count = ?, summary_written = ? WHERE id = ?`
      ).run(session.messageCount, session.summaryWritten ? 1 : 0, session.id)
    }

    this.sessions.clear()
    this.timers.clear()
  }

  /**
   * Get session metadata from SQLite
   */
  getSessionMetadata(sessionId: string): {
    id: string
    started_at: string
    ended_at: string | null
    message_count: number
    summary_written: number
    source: string
    type: string
    parent_session_id: string | null
    last_activity: string | null
    session_user: string | null
    prompt_tokens: number
    completion_tokens: number
  } | undefined {
    return this.db.prepare(
      `SELECT id, started_at, ended_at, message_count, summary_written, source, type, parent_session_id, last_activity, session_user, prompt_tokens, completion_tokens
       FROM sessions WHERE id = ?`
    ).get(sessionId) as {
      id: string
      started_at: string
      ended_at: string | null
      message_count: number
      summary_written: number
      source: string
      type: string
      parent_session_id: string | null
      last_activity: string | null
      session_user: string | null
      prompt_tokens: number
      completion_tokens: number
    } | undefined
  }
}
