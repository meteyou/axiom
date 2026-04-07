import type { Database } from './database.js'
import { appendToDailyFile } from './memory.js'
import { logToolCall } from './token-logger.js'

export interface SessionInfo {
  id: string
  userId: string
  source: string
  startedAt: number // timestamp ms
  lastActivity: number // timestamp ms
  messageCount: number
  summaryWritten: boolean
}

export interface SessionManagerOptions {
  db: Database
  timeoutMinutes?: number
  memoryDir?: string
  /** Called to generate a summary of the session. Returns the summary text. */
  onSummarize?: (sessionId: string, userId: string) => Promise<string>
  /** Called when a session is disposed (after summary if applicable) */
  onSessionEnd?: (session: SessionInfo, summary: string | null) => void
}

/**
 * Manages active sessions per user with timeout and auto-summarization
 */
export class SessionManager {
  private sessions: Map<string, SessionInfo> = new Map() // userId -> session
  private timers: Map<string, ReturnType<typeof setTimeout>> = new Map() // userId -> timeout timer
  private db: Database
  private timeoutMs: number
  private memoryDir?: string
  private onSummarize?: (sessionId: string, userId: string) => Promise<string>
  private onSessionEnd?: (session: SessionInfo, summary: string | null) => void

  constructor(options: SessionManagerOptions) {
    this.db = options.db
    this.timeoutMs = (options.timeoutMinutes ?? 15) * 60 * 1000
    this.memoryDir = options.memoryDir
    this.onSummarize = options.onSummarize
    this.onSessionEnd = options.onSessionEnd

    // Close any orphaned sessions from a previous server run
    this.closeOrphanedSessions()
  }

  /**
   * Close sessions that were left open from a previous server run
   * (no ended_at). These exist because the server crashed or restarted
   * without graceful shutdown.
   */
  private closeOrphanedSessions(): void {
    const orphaned = this.db.prepare(
      `SELECT id, message_count, summary_written, source FROM sessions WHERE ended_at IS NULL`
    ).all() as Array<{ id: string; message_count: number; summary_written: number; source: string }>

    if (orphaned.length === 0) return

    console.log(`[session] Closing ${orphaned.length} orphaned session(s) from previous run`)

    for (const session of orphaned) {
      this.db.prepare(
        `UPDATE sessions SET ended_at = datetime('now'), summary_written = ? WHERE id = ?`
      ).run(session.summary_written, session.id)

      // Log to tool_calls so it shows up in the activity log
      logToolCall(this.db, {
        sessionId: session.id,
        toolName: 'session_timeout',
        input: JSON.stringify({
          reason: 'server_restart',
          messageCount: session.message_count,
        }),
        output: JSON.stringify({
          summaryWritten: false,
          summary: null,
          note: 'Session closed due to server restart',
        }),
        durationMs: 0,
        status: 'success',
      })
    }
  }

  /**
   * Update the timeout duration (in minutes)
   */
  setTimeoutMinutes(minutes: number): void {
    this.timeoutMs = minutes * 60 * 1000
  }


  /**
   * Get or create a session for a user. Resets the inactivity timer.
   */
  getOrCreateSession(userId: string, source: string = 'web'): SessionInfo {
    let session = this.sessions.get(userId)

    if (!session) {
      const id = `session-${userId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      session = {
        id,
        userId,
        source,
        startedAt: Date.now(),
        lastActivity: Date.now(),
        messageCount: 0,
        summaryWritten: false,
      }
      this.sessions.set(userId, session)

      // Insert into SQLite
      this.db.prepare(
        `INSERT INTO sessions (id, user_id, source, started_at, message_count, summary_written)
         VALUES (?, ?, ?, datetime(? / 1000, 'unixepoch'), 0, 0)`
      ).run(session.id, null, source, session.startedAt)

      // Log session start to tool_calls for activity log visibility
      logToolCall(this.db, {
        sessionId: session.id,
        toolName: 'session_start',
        input: JSON.stringify({ userId, source }),
        output: JSON.stringify({ sessionId: session.id }),
        durationMs: 0,
        status: 'success',
      })
    }

    // Update activity and reset timer
    session.lastActivity = Date.now()
    this.resetTimer(userId)

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

      // Update SQLite
      this.db.prepare(
        `UPDATE sessions SET message_count = ? WHERE id = ?`
      ).run(session.messageCount, session.id)
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
   * End a session: summarize and dispose
   */
  private async endSession(userId: string, reason: 'timeout' | 'manual' = 'timeout'): Promise<string | null> {
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
        summary = await this.onSummarize(session.id, userId)
        if (summary) {
          // Append summary to today's daily file
          const now = new Date()
          const hh = String(now.getHours()).padStart(2, '0')
          const mm = String(now.getMinutes()).padStart(2, '0')
          const formattedSummary = `\n## ${hh}:${mm}\n\n${summary}\n`
          appendToDailyFile(formattedSummary, undefined, this.memoryDir)
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
  } | undefined {
    return this.db.prepare(
      `SELECT id, started_at, ended_at, message_count, summary_written, source FROM sessions WHERE id = ?`
    ).get(sessionId) as {
      id: string
      started_at: string
      ended_at: string | null
      message_count: number
      summary_written: number
      source: string
    } | undefined
  }
}
