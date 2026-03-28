import type { Database } from './database.js'
import { appendToDailyFile } from './memory.js'

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

    return this.endSession(userId)
  }

  /**
   * End a session: summarize and dispose
   */
  private async endSession(userId: string): Promise<string | null> {
    const session = this.sessions.get(userId)
    if (!session) return null

    // Clear the timeout timer
    this.clearTimer(userId)

    let summary: string | null = null

    // Generate summary if there were messages and a summarizer is configured
    if (session.messageCount > 0 && this.onSummarize) {
      try {
        summary = await this.onSummarize(session.id, userId)
        if (summary) {
          // Append summary to today's daily file
          const timestamp = new Date().toISOString().split('T')[1].split('.')[0]
          const formattedSummary = `\n## Session Summary (${timestamp})\n\n${summary}\n`
          appendToDailyFile(formattedSummary, undefined, this.memoryDir)
          session.summaryWritten = true
        }
      } catch (err) {
        console.error('Failed to generate session summary:', err)
      }
    }

    // Update SQLite with end time and summary flag
    this.db.prepare(
      `UPDATE sessions SET ended_at = datetime('now'), message_count = ?, summary_written = ? WHERE id = ?`
    ).run(session.messageCount, session.summaryWritten ? 1 : 0, session.id)

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

    const timer = setTimeout(() => {
      this.endSession(userId).catch(err => {
        console.error(`Session timeout error for user ${userId}:`, err)
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
