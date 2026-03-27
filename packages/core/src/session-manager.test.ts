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
    it('creates a new session for a user', () => {
      const manager = new SessionManager({ db, memoryDir })
      const session = manager.getOrCreateSession('user1', 'telegram')

      expect(session.id).toMatch(/^session-user1-/)
      expect(session.userId).toBe('user1')
      expect(session.source).toBe('telegram')
      expect(session.messageCount).toBe(0)
      expect(session.summaryWritten).toBe(false)
    })

    it('returns existing session for same user', () => {
      const manager = new SessionManager({ db, memoryDir })
      const session1 = manager.getOrCreateSession('user1')
      const session2 = manager.getOrCreateSession('user1')

      expect(session1.id).toBe(session2.id)
    })

    it('creates separate sessions for different users', () => {
      const manager = new SessionManager({ db, memoryDir })
      const session1 = manager.getOrCreateSession('user1')
      const session2 = manager.getOrCreateSession('user2')

      expect(session1.id).not.toBe(session2.id)
    })

    it('stores session metadata in SQLite', () => {
      const manager = new SessionManager({ db, memoryDir })
      const session = manager.getOrCreateSession('user1', 'web')

      const metadata = manager.getSessionMetadata(session.id)
      expect(metadata).toBeDefined()
      expect(metadata!.id).toBe(session.id)
      expect(metadata!.source).toBe('web')
      expect(metadata!.message_count).toBe(0)
      expect(metadata!.summary_written).toBe(0)
    })
  })

  describe('message recording', () => {
    it('increments message count', () => {
      const manager = new SessionManager({ db, memoryDir })
      manager.getOrCreateSession('user1')

      manager.recordMessage('user1')
      manager.recordMessage('user1')
      manager.recordMessage('user1')

      const session = manager.getSession('user1')
      expect(session!.messageCount).toBe(3)
    })

    it('updates message count in SQLite', () => {
      const manager = new SessionManager({ db, memoryDir })
      const session = manager.getOrCreateSession('user1')

      manager.recordMessage('user1')
      manager.recordMessage('user1')

      const metadata = manager.getSessionMetadata(session.id)
      expect(metadata!.message_count).toBe(2)
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

      const session = manager.getOrCreateSession('user1')
      manager.recordMessage('user1')

      // Advance past timeout
      await vi.advanceTimersByTimeAsync(61 * 1000)

      expect(onSessionEnd).toHaveBeenCalledWith(expect.objectContaining({
        id: session.id,
        userId: 'user1',
      }))

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

      manager.getOrCreateSession('user1')
      manager.recordMessage('user1')

      await vi.advanceTimersByTimeAsync(61 * 1000)

      expect(onSummarize).toHaveBeenCalled()

      // Check that summary was appended to daily file
      const today = new Date().toISOString().split('T')[0]
      const dailyPath = path.join(memoryDir, 'daily', `${today}.md`)
      expect(fs.existsSync(dailyPath)).toBe(true)
      const dailyContent = fs.readFileSync(dailyPath, 'utf-8')
      expect(dailyContent).toContain('Session Summary')
      expect(dailyContent).toContain('This session discussed testing.')
    })

    it('updates SQLite on session end with summary flag', async () => {
      const onSummarize = vi.fn().mockResolvedValue('Summary text')
      const manager = new SessionManager({
        db,
        memoryDir,
        timeoutMinutes: 1,
        onSummarize,
      })

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

      manager.getOrCreateSession('user1')
      manager.recordMessage('user1')

      const summary = await manager.handleNewCommand('user1')

      expect(summary).toBe('Session about deployment.')
      expect(manager.hasActiveSession('user1')).toBe(false)
      expect(onSummarize).toHaveBeenCalled()
    })

    it('returns null when no active session', async () => {
      const manager = new SessionManager({ db, memoryDir })

      const result = await manager.handleNewCommand('user1')
      expect(result).toBeNull()
    })

    it('subsequent messages start a fresh session', async () => {
      const manager = new SessionManager({ db, memoryDir })

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

  describe('dispose', () => {
    it('clears all sessions and updates SQLite', async () => {
      const manager = new SessionManager({ db, memoryDir })

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
    it('updates the timeout duration', () => {
      const manager = new SessionManager({
        db,
        memoryDir,
        timeoutMinutes: 15,
      })

      // This should not throw
      manager.setTimeoutMinutes(30)
    })
  })
})
