import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import { SessionManager } from './session-manager.js'
import type { SessionType } from './session-manager.js'
import { migrateSessionOwners } from './session-owners.js'
import { queryUsageStats } from './usage-stats.js'

describe('usage per user', () => {
  let db: Database

  beforeEach(() => {
    db = initDatabase(':memory:')
    db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1, 'admin', 'h', 'admin'), (2, 'alice', 'h', 'user')").run()
  })
  afterEach(() => db.close())

  const ownerOf = (id: string) =>
    (db.prepare('SELECT user_id FROM sessions WHERE id = ?').get(id) as { user_id: number | null }).user_id

  describe('session ownership', () => {
    const types: SessionType[] = ['task', 'heartbeat', 'consolidation', 'loop_detection']
    for (const type of types) {
      it(`sets the owner for ${type} sessions`, () => {
        const manager = new SessionManager({ db, memoryDir: "/tmp" })
        expect(ownerOf(manager.createSession({ type, source: 'system', userId: '2' }).id)).toBe(2)
      })
      it(`falls back to the bootstrap admin for ownerless ${type} sessions`, () => {
        const manager = new SessionManager({ db, memoryDir: "/tmp" })
        expect(ownerOf(manager.createSession({ type, source: 'system' }).id)).toBe(1)
      })
    }

    it('sets the owner of interactive sessions', () => {
      const manager = new SessionManager({ db, memoryDir: "/tmp" })
      expect(ownerOf(manager.getOrCreateSession('2').id)).toBe(2)
    })

    it('attributes interactive sessions of non-numeric users to the bootstrap admin', () => {
      const manager = new SessionManager({ db, memoryDir: "/tmp" })
      const id = manager.getOrCreateSession('telegram-123', 'telegram').id
      expect(ownerOf(id)).toBe(1)
      migrateSessionOwners(db)
      expect(ownerOf(id)).toBe(1)
    })
  })

  describe('backfill', () => {
    it('attributes legacy rows by session_user, task owner, lineage, else bootstrap admin, idempotently', () => {
      const ins = db.prepare('INSERT INTO sessions (id, session_user, source, type, parent_session_id) VALUES (?, ?, ?, ?, ?)')
      ins.run('s-user', '2', 'web', 'interactive', null)
      ins.run('s-name', 'alice', 'web', 'interactive', null)
      ins.run('s-task', null, 'system', 'task', null)
      ins.run('s-child', null, 'system', 'loop_detection', 's-task')
      ins.run('s-orphan', null, 'system', 'task', null)
      db.prepare("INSERT INTO tasks (id, name, prompt, status, trigger_type, session_id, owner_user_id) VALUES ('t', 'n', 'p', 'completed', 'agent', 's-task', 2)").run()

      migrateSessionOwners(db)
      const owners = () => Object.fromEntries(
        (db.prepare('SELECT id, user_id FROM sessions').all() as Array<{ id: string; user_id: number }>).map(r => [r.id, r.user_id]),
      )
      expect(owners()).toEqual({ 's-user': 2, 's-name': 1, 's-task': 2, 's-child': 2, 's-orphan': 1 })

      db.prepare("UPDATE sessions SET user_id = 2 WHERE id = 's-orphan'").run()
      migrateSessionOwners(db)
      expect(owners()['s-orphan']).toBe(2)
    })
  })

  describe('per-user breakdown', () => {
    it('returns totals plus per-user rows, honoring filters', () => {
      db.prepare("INSERT INTO sessions (id, user_id, source, type) VALUES ('a', 1, 'web', 'interactive'), ('b', 2, 'web', 'interactive')").run()
      const ins = db.prepare('INSERT INTO token_usage (provider, model, prompt_tokens, completion_tokens, estimated_cost, session_id) VALUES (?, ?, ?, ?, ?, ?)')
      ins.run('p', 'm', 10, 5, 1, 'a')
      ins.run('p', 'm', 20, 5, 2, 'b')
      ins.run('q', 'm', 1, 1, 1, 'b')

      const all = queryUsageStats(db)
      expect(all.totals.requests).toBe(3)
      expect(all.perUser.map(r => [r.username, r.requests, r.estimatedCost])).toEqual([['alice', 2, 3], ['admin', 1, 1]])

      const filtered = queryUsageStats(db, { provider: 'p' })
      expect(filtered.perUser.map(r => [r.username, r.requests])).toEqual([['alice', 1], ['admin', 1]])
    })

    it('marks users that no longer exist as deleted', () => {
      db.pragma('foreign_keys = OFF')
      db.prepare("INSERT INTO sessions (id, user_id, source, type) VALUES ('g', 99, 'web', 'interactive')").run()
      db.prepare("INSERT INTO token_usage (provider, model, prompt_tokens, completion_tokens, estimated_cost, session_id) VALUES ('p', 'm', 1, 1, 1, 'g')").run()
      const [row] = queryUsageStats(db).perUser
      expect(row).toMatchObject({ userId: 99, username: null, deleted: true })
    })
  })
})
