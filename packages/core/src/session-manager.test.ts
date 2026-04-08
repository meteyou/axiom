import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest'
import { SessionManager } from './session-manager.js'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

describe('SessionManager', () => {
  let db: Database
  let tmpDir: string
  let memoryDir: string
  let dbPath: string

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `openagent-session-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    memoryDir = path.join(tmpDir, 'memory')
    dbPath = path.join(tmpDir, 'db', 'test.db')

    // Create memory dir structure
    fs.mkdirSync(path.join(memoryDir, 'daily'), { recursive: true })
    fs.writeFileSync(path.join(memoryDir, 'SOUL.md'), '# Soul\n', 'utf-8')
    fs.writeFileSync(path.join(memoryDir, 'AGENTS.md'), '# Agent Memory\n', 'utf-8')

    db = initDatabase(dbPath)
  })

  afterEach(() => {
    if (db) {
      db.close()
    }
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  describe('session creation', () => {
    it('creates a new session for a user', async () => {
      const manager = new SessionManager({ db, memoryDir })
      await manager.init()
      const session = manager.getOrCreateSession('user1', 'telegram')

      expect(session.id).toMatch(/^session-user1-/)
      expect(session.userId).toBe('user1')
      expect(session.source).toBe('telegram')
      expect(session.messageCount).toBe(0)
      expect(session.summaryWritten).toBe(false)
      expect(session.restored).toBe(false)
    })

    it('returns existing session for same user', async () => {
      const manager = new SessionManager({ db, memoryDir })
      await manager.init()
      const session1 = manager.getOrCreateSession('user1')
      const session2 = manager.getOrCreateSession('user1')

      expect(session1.id).toBe(session2.id)
    })

    it('creates separate sessions for different users', async () => {
      const manager = new SessionManager({ db, memoryDir })
      await manager.init()
      const session1 = manager.getOrCreateSession('user1')
      const session2 = manager.getOrCreateSession('user2')

      expect(session1.id).not.toBe(session2.id)
    })

    it('stores session metadata in SQLite including last_activity and session_user', async () => {
      const manager = new SessionManager({ db, memoryDir })
      await manager.init()
      const session = manager.getOrCreateSession('user1', 'web')

      const metadata = manager.getSessionMetadata(session.id)
      expect(metadata).toBeDefined()
      expect(metadata!.id).toBe(session.id)
      expect(metadata!.source).toBe('web')
      expect(metadata!.message_count).toBe(0)
      expect(metadata!.summary_written).toBe(0)
      expect(metadata!.last_activity).not.toBeNull()
      expect(metadata!.session_user).toBe('user1')
    })
  })

  describe('message recording', () => {
    it('increments message count', async () => {
      const manager = new SessionManager({ db, memoryDir })
      await manager.init()
      manager.getOrCreateSession('user1')

      manager.recordMessage('user1')
      manager.recordMessage('user1')
      manager.recordMessage('user1')

      const session = manager.getSession('user1')
      expect(session!.messageCount).toBe(3)
    })

    it('updates message count and last_activity in SQLite', async () => {
      const manager = new SessionManager({ db, memoryDir })
      await manager.init()
      const session = manager.getOrCreateSession('user1')

      const metadataBefore = manager.getSessionMetadata(session.id)
      const activityBefore = metadataBefore!.last_activity

      // Small delay to ensure timestamp difference
      await new Promise(resolve => setTimeout(resolve, 10))

      manager.recordMessage('user1')
      manager.recordMessage('user1')

      const metadataAfter = manager.getSessionMetadata(session.id)
      expect(metadataAfter!.message_count).toBe(2)
      // last_activity should be updated (may be same second though)
      expect(metadataAfter!.last_activity).not.toBeNull()
    })
  })

  describe('session timeout', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('fires timeout after configured inactivity period', async () => {
      const onSessionEnd = vi.fn()
      const manager = new SessionManager({
        db,
        memoryDir,
        timeoutMinutes: 1, // 1 minute for fast test
        onSessionEnd,
      })
      await manager.init()

      const session = manager.getOrCreateSession('user1')
      manager.recordMessage('user1')

      // Advance past timeout
      await vi.advanceTimersByTimeAsync(61 * 1000)

      expect(onSessionEnd).toHaveBeenCalledWith(expect.objectContaining({
        id: session.id,
        userId: 'user1',
      }), null)

      // Session should be gone
      expect(manager.hasActiveSession('user1')).toBe(false)
    })

    it('resets timer on new message', async () => {
      const onSessionEnd = vi.fn()
      const manager = new SessionManager({
        db,
        memoryDir,
        timeoutMinutes: 1,
        onSessionEnd,
      })
      await manager.init()

      manager.getOrCreateSession('user1')
      manager.recordMessage('user1')

      // Advance 50 seconds (not yet timed out)
      await vi.advanceTimersByTimeAsync(50 * 1000)
      expect(onSessionEnd).not.toHaveBeenCalled()

      // Record another message (resets timer)
      manager.recordMessage('user1')

      // Advance 50 more seconds (still within new timer)
      await vi.advanceTimersByTimeAsync(50 * 1000)
      expect(onSessionEnd).not.toHaveBeenCalled()

      // Advance past new timeout
      await vi.advanceTimersByTimeAsync(11 * 1000)
      expect(onSessionEnd).toHaveBeenCalled()
    })

    it('calls onSummarize on timeout when messages exist', async () => {
      const onSummarize = vi.fn().mockResolvedValue('This session discussed testing.')
      const manager = new SessionManager({
        db,
        memoryDir,
        timeoutMinutes: 1,
        onSummarize,
      })
      await manager.init()

      manager.getOrCreateSession('user1')
      manager.recordMessage('user1')

      await vi.advanceTimersByTimeAsync(61 * 1000)

      expect(onSummarize).toHaveBeenCalled()

      // Check that summary was appended to daily file
      const today = new Date().toISOString().split('T')[0]
      const dailyPath = path.join(memoryDir, 'daily', `${today}.md`)
      expect(fs.existsSync(dailyPath)).toBe(true)
      const dailyContent = fs.readFileSync(dailyPath, 'utf-8')
      expect(dailyContent).toMatch(/## \d{2}:\d{2}/)
      expect(dailyContent).toContain('This session discussed testing.')
    })

    it('uses lastActivity timestamp for daily file entry', async () => {
      const onSummarize = vi.fn().mockResolvedValue('Summary text')
      const manager = new SessionManager({
        db,
        memoryDir,
        timeoutMinutes: 1,
        onSummarize,
      })
      await manager.init()

      const session = manager.getOrCreateSession('user1')
      manager.recordMessage('user1')

      // The lastActivity is set to "now" (fake timer time)
      const lastActivityDate = new Date(session.lastActivity)
      const expectedHH = String(lastActivityDate.getHours()).padStart(2, '0')
      const expectedMM = String(lastActivityDate.getMinutes()).padStart(2, '0')
      const expectedDateStr = lastActivityDate.toISOString().split('T')[0]

      await vi.advanceTimersByTimeAsync(61 * 1000)

      // Summary should be in the daily file for the lastActivity date
      const dailyPath = path.join(memoryDir, 'daily', `${expectedDateStr}.md`)
      expect(fs.existsSync(dailyPath)).toBe(true)
      const content = fs.readFileSync(dailyPath, 'utf-8')
      expect(content).toContain(`## ${expectedHH}:${expectedMM}`)
    })

    it('updates SQLite on session end with summary flag', async () => {
      const onSummarize = vi.fn().mockResolvedValue('Summary text')
      const manager = new SessionManager({
        db,
        memoryDir,
        timeoutMinutes: 1,
        onSummarize,
      })
      await manager.init()

      const session = manager.getOrCreateSession('user1')
      manager.recordMessage('user1')

      await vi.advanceTimersByTimeAsync(61 * 1000)

      const metadata = manager.getSessionMetadata(session.id)
      expect(metadata!.ended_at).not.toBeNull()
      expect(metadata!.summary_written).toBe(1)
      expect(metadata!.message_count).toBe(1)
    })

    it('does not call onSummarize when no messages', async () => {
      const onSummarize = vi.fn().mockResolvedValue('Summary')
      const manager = new SessionManager({
        db,
        memoryDir,
        timeoutMinutes: 1,
        onSummarize,
      })
      await manager.init()

      manager.getOrCreateSession('user1')
      // No messages recorded

      await vi.advanceTimersByTimeAsync(61 * 1000)

      expect(onSummarize).not.toHaveBeenCalled()
    })
  })

  describe('/new command', () => {
    it('ends session and returns summary', async () => {
      const onSummarize = vi.fn().mockResolvedValue('Session about deployment.')
      const manager = new SessionManager({
        db,
        memoryDir,
        timeoutMinutes: 15,
        onSummarize,
      })
      await manager.init()

      manager.getOrCreateSession('user1')
      manager.recordMessage('user1')

      const summary = await manager.handleNewCommand('user1')

      expect(summary).toBe('Session about deployment.')
      expect(manager.hasActiveSession('user1')).toBe(false)
      expect(onSummarize).toHaveBeenCalled()
    })

    it('returns null when no active session', async () => {
      const manager = new SessionManager({ db, memoryDir })
      await manager.init()

      const result = await manager.handleNewCommand('user1')
      expect(result).toBeNull()
    })

    it('subsequent messages start a fresh session', async () => {
      const manager = new SessionManager({ db, memoryDir })
      await manager.init()

      const session1 = manager.getOrCreateSession('user1')
      manager.recordMessage('user1')

      await manager.handleNewCommand('user1')

      const session2 = manager.getOrCreateSession('user1')
      expect(session2.id).not.toBe(session1.id)
      expect(session2.messageCount).toBe(0)
    })

    it('appends summary to daily file', async () => {
      const onSummarize = vi.fn().mockResolvedValue('Discussed Docker setup.')
      const manager = new SessionManager({
        db,
        memoryDir,
        timeoutMinutes: 15,
        onSummarize,
      })
      await manager.init()

      manager.getOrCreateSession('user1')
      manager.recordMessage('user1')

      await manager.handleNewCommand('user1')

      const today = new Date().toISOString().split('T')[0]
      const dailyPath = path.join(memoryDir, 'daily', `${today}.md`)
      expect(fs.existsSync(dailyPath)).toBe(true)
      const content = fs.readFileSync(dailyPath, 'utf-8')
      expect(content).toContain('Discussed Docker setup.')
    })
  })

  describe('endAllSessions', () => {
    it('ends active sessions and emits session end callbacks', async () => {
      const onSummarize = vi.fn().mockResolvedValue('Provider switched.')
      const onSessionEnd = vi.fn()
      const manager = new SessionManager({
        db,
        memoryDir,
        onSummarize,
        onSessionEnd,
      })
      await manager.init()

      manager.getOrCreateSession('user1')
      manager.recordMessage('user1')
      manager.getOrCreateSession('user2')
      manager.recordMessage('user2')

      await manager.endAllSessions('provider_change')

      expect(manager.hasActiveSession('user1')).toBe(false)
      expect(manager.hasActiveSession('user2')).toBe(false)
      expect(onSummarize).toHaveBeenCalledTimes(2)
      expect(onSessionEnd).toHaveBeenCalledTimes(2)
    })
  })

  describe('dispose', () => {
    it('clears all sessions and updates SQLite', async () => {
      const manager = new SessionManager({ db, memoryDir })
      await manager.init()

      const s1 = manager.getOrCreateSession('user1')
      const s2 = manager.getOrCreateSession('user2')
      manager.recordMessage('user1')

      await manager.dispose()

      expect(manager.hasActiveSession('user1')).toBe(false)
      expect(manager.hasActiveSession('user2')).toBe(false)

      // Both sessions should be ended in SQLite
      const m1 = manager.getSessionMetadata(s1.id)
      const m2 = manager.getSessionMetadata(s2.id)
      expect(m1!.ended_at).not.toBeNull()
      expect(m2!.ended_at).not.toBeNull()
    })
  })

  describe('setTimeoutMinutes', () => {
    it('updates the timeout duration', async () => {
      const manager = new SessionManager({
        db,
        memoryDir,
        timeoutMinutes: 15,
      })
      await manager.init()

      // This should not throw
      manager.setTimeoutMinutes(30)
    })
  })

  describe('session summaries always generate', () => {
    it('always generates summary when session has messages and onSummarize is configured', async () => {
      const onSummarize = vi.fn().mockResolvedValue('Summary text')
      const manager = new SessionManager({
        db,
        memoryDir,
        timeoutMinutes: 15,
        onSummarize,
      })
      await manager.init()

      manager.getOrCreateSession('user1')
      manager.recordMessage('user1')

      const summary = await manager.handleNewCommand('user1')

      expect(onSummarize).toHaveBeenCalled()
      expect(summary).toBe('Summary text')
    })
  })

  describe('orphaned session handling', () => {
    it('summarizes orphaned sessions with elapsed timeout on init', async () => {
      // Create a session and simulate a crash (don't call dispose/endSession)
      const manager1 = new SessionManager({
        db,
        memoryDir,
        timeoutMinutes: 15,
      })
      await manager1.init()

      const session = manager1.getOrCreateSession('user1', 'web')
      manager1.recordMessage('user1')

      // Add chat messages to DB so the summary has content
      db.prepare(
        `INSERT INTO chat_messages (session_id, role, content) VALUES (?, 'user', 'How do I deploy?')`
      ).run(session.id)
      db.prepare(
        `INSERT INTO chat_messages (session_id, role, content) VALUES (?, 'assistant', 'You can use Docker or Kubernetes.')`
      ).run(session.id)

      // Manually set last_activity to 2 hours ago to simulate elapsed timeout
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
      db.prepare(
        `UPDATE sessions SET last_activity = datetime(? / 1000, 'unixepoch') WHERE id = ?`
      ).run(twoHoursAgo.getTime(), session.id)

      // Clear timers without closing sessions (simulate crash)
      // manager1 goes out of scope

      // Create a new manager (simulates server restart)
      const onSummarize = vi.fn().mockResolvedValue('Session covered deployment strategies.')
      const manager2 = new SessionManager({
        db,
        memoryDir,
        timeoutMinutes: 15,
        onSummarize,
      })
      await manager2.init()

      // onSummarize should have been called with conversation history
      expect(onSummarize).toHaveBeenCalledWith(
        session.id,
        'user1',
        expect.stringContaining('How do I deploy?')
      )

      // Session should be closed in DB
      const metadata = manager2.getSessionMetadata(session.id)
      expect(metadata!.ended_at).not.toBeNull()
      expect(metadata!.summary_written).toBe(1)

      // Summary should NOT be in today's daily file but in the file for twoHoursAgo's date
      const expectedDate = twoHoursAgo.toISOString().split('T')[0]
      const dailyPath = path.join(memoryDir, 'daily', `${expectedDate}.md`)
      expect(fs.existsSync(dailyPath)).toBe(true)
      const content = fs.readFileSync(dailyPath, 'utf-8')
      expect(content).toContain('Session covered deployment strategies.')

      // Should use the lastActivity time, not current time
      const expectedHH = String(twoHoursAgo.getHours()).padStart(2, '0')
      const expectedMM = String(twoHoursAgo.getMinutes()).padStart(2, '0')
      expect(content).toContain(`## ${expectedHH}:${expectedMM}`)

      // No active session should remain
      expect(manager2.hasActiveSession('user1')).toBe(false)
    })

    it('writes summary to previous day daily file when crash spans midnight', async () => {
      const manager1 = new SessionManager({
        db,
        memoryDir,
        timeoutMinutes: 15,
      })
      await manager1.init()

      const session = manager1.getOrCreateSession('user1', 'web')
      manager1.recordMessage('user1')

      // Add chat messages
      db.prepare(
        `INSERT INTO chat_messages (session_id, role, content) VALUES (?, 'user', 'Late night question')`
      ).run(session.id)

      // Set last_activity to yesterday at 23:35
      const yesterday = new Date()
      yesterday.setDate(yesterday.getDate() - 1)
      yesterday.setHours(23, 35, 0, 0)

      db.prepare(
        `UPDATE sessions SET last_activity = datetime(? / 1000, 'unixepoch') WHERE id = ?`
      ).run(yesterday.getTime(), session.id)

      // Simulate restart
      const onSummarize = vi.fn().mockResolvedValue('Late night deployment discussion.')
      const manager2 = new SessionManager({
        db,
        memoryDir,
        timeoutMinutes: 15,
        onSummarize,
      })
      await manager2.init()

      // Summary should be in yesterday's daily file at 23:35
      const expectedDateStr = yesterday.toISOString().split('T')[0]
      const dailyPath = path.join(memoryDir, 'daily', `${expectedDateStr}.md`)
      expect(fs.existsSync(dailyPath)).toBe(true)
      const content = fs.readFileSync(dailyPath, 'utf-8')
      expect(content).toContain('## 23:35')
      expect(content).toContain('Late night deployment discussion.')
    })

    it('restores orphaned sessions with remaining timeout', async () => {
      vi.useFakeTimers()

      try {
        const manager1 = new SessionManager({
          db,
          memoryDir,
          timeoutMinutes: 15,
        })
        await manager1.init()

        const session = manager1.getOrCreateSession('user1', 'web')
        manager1.recordMessage('user1')

        // Set last_activity to 5 minutes ago (timeout is 15 min, so 10 min remaining)
        const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000)
        db.prepare(
          `UPDATE sessions SET last_activity = datetime(? / 1000, 'unixepoch') WHERE id = ?`
        ).run(fiveMinAgo.getTime(), session.id)

        // Add chat messages for potential summarization
        db.prepare(
          `INSERT INTO chat_messages (session_id, role, content) VALUES (?, 'user', 'Quick question')`
        ).run(session.id)

        // Clear all timers from manager1 (simulates server crash — timers are lost)
        vi.clearAllTimers()

        // Simulate restart — create new manager
        const onSummarize = vi.fn().mockResolvedValue('Restored session summary.')
        const onSessionEnd = vi.fn()
        const manager2 = new SessionManager({
          db,
          memoryDir,
          timeoutMinutes: 15,
          onSummarize,
          onSessionEnd,
        })
        await manager2.init()

        // Session should be restored
        expect(manager2.hasActiveSession('user1')).toBe(true)
        const restored = manager2.getSession('user1')
        expect(restored).toBeDefined()
        expect(restored!.id).toBe(session.id)
        expect(restored!.restored).toBe(true)
        expect(restored!.messageCount).toBe(1)

        // onSummarize should NOT have been called yet (timeout not elapsed)
        expect(onSummarize).not.toHaveBeenCalled()

        // Advance 10 minutes (remaining timeout)
        await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1000)

        // Now the session should have timed out and been summarized
        expect(onSummarize).toHaveBeenCalled()
        expect(onSessionEnd).toHaveBeenCalled()
        expect(manager2.hasActiveSession('user1')).toBe(false)

        // Conversation history from DB should have been passed (restored session)
        expect(onSummarize).toHaveBeenCalledWith(
          session.id,
          'user1',
          expect.stringContaining('Quick question')
        )
      } finally {
        vi.useRealTimers()
      }
    })

    it('restored session gets new messages and resets timer', async () => {
      vi.useFakeTimers()

      try {
        const manager1 = new SessionManager({
          db,
          memoryDir,
          timeoutMinutes: 15,
        })
        await manager1.init()

        const session = manager1.getOrCreateSession('user1', 'web')
        manager1.recordMessage('user1')

        // Set last_activity to 5 minutes ago
        const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000)
        db.prepare(
          `UPDATE sessions SET last_activity = datetime(? / 1000, 'unixepoch') WHERE id = ?`
        ).run(fiveMinAgo.getTime(), session.id)

        // Clear all timers from manager1 (simulates server crash)
        vi.clearAllTimers()

        // Simulate restart
        const onSessionEnd = vi.fn()
        const manager2 = new SessionManager({
          db,
          memoryDir,
          timeoutMinutes: 15,
          onSessionEnd,
        })
        await manager2.init()

        expect(manager2.hasActiveSession('user1')).toBe(true)

        // Advance 5 minutes (still within remaining 10 min)
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
        expect(onSessionEnd).not.toHaveBeenCalled()

        // Record a new message (should reset timer to full 15 minutes)
        manager2.recordMessage('user1')

        // Advance 14 minutes (should still be within new full timer)
        await vi.advanceTimersByTimeAsync(14 * 60 * 1000)
        expect(onSessionEnd).not.toHaveBeenCalled()

        // Advance 2 more minutes (past 15 min timer)
        await vi.advanceTimersByTimeAsync(2 * 60 * 1000)
        expect(onSessionEnd).toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
      }
    })

    it('handles orphaned sessions without chat_messages gracefully', async () => {
      const manager1 = new SessionManager({
        db,
        memoryDir,
        timeoutMinutes: 15,
      })
      await manager1.init()

      const session = manager1.getOrCreateSession('user1', 'web')
      manager1.recordMessage('user1')

      // Set last_activity far in the past (no chat messages in DB)
      const longAgo = new Date(Date.now() - 24 * 60 * 60 * 1000)
      db.prepare(
        `UPDATE sessions SET last_activity = datetime(? / 1000, 'unixepoch') WHERE id = ?`
      ).run(longAgo.getTime(), session.id)

      const onSummarize = vi.fn().mockResolvedValue('Summary')
      const manager2 = new SessionManager({
        db,
        memoryDir,
        timeoutMinutes: 15,
        onSummarize,
      })
      await manager2.init()

      // No chat_messages → no conversation history → onSummarize should NOT be called
      // (buildConversationHistory returns null, so orphan is closed without summary)
      expect(onSummarize).not.toHaveBeenCalled()

      // Session should still be closed in DB
      const metadata = manager2.getSessionMetadata(session.id)
      expect(metadata!.ended_at).not.toBeNull()
    })

    it('handles pre-migration sessions without last_activity (falls back to started_at)', async () => {
      // Manually insert a session without last_activity (simulating pre-migration data)
      const sessionId = 'session-olduser-1234567890123-abc123'
      db.prepare(
        `INSERT INTO sessions (id, user_id, source, started_at, message_count, summary_written)
         VALUES (?, NULL, 'web', datetime('now', '-2 hours'), 3, 0)`
      ).run(sessionId)

      // Add chat messages
      db.prepare(
        `INSERT INTO chat_messages (session_id, role, content) VALUES (?, 'user', 'Old message')`
      ).run(sessionId)

      const onSummarize = vi.fn().mockResolvedValue('Old session summary.')
      const manager = new SessionManager({
        db,
        memoryDir,
        timeoutMinutes: 15,
        onSummarize,
      })
      await manager.init()

      // Should handle gracefully — fall back to started_at
      expect(onSummarize).toHaveBeenCalled()

      const metadata = manager.getSessionMetadata(sessionId)
      expect(metadata!.ended_at).not.toBeNull()
      expect(metadata!.summary_written).toBe(1)
    })
  })
})
