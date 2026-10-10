import { beforeEach, describe, expect, it } from 'vitest'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import { getBootstrapAdminId, isMultiUser, resolveUserScope } from './user-scope.js'

describe('user-scope', () => {
  let db: Database

  beforeEach(() => {
    db = initDatabase(':memory:')
  })

  function addUser(username: string, role: string): number {
    return Number(db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(username, 'h', role).lastInsertRowid)
  }

  it('has no bootstrap admin on an empty instance', () => {
    expect(getBootstrapAdminId(db)).toBeNull()
    expect(isMultiUser(db)).toBe(false)
  })

  it('treats the lowest user id as bootstrap admin', () => {
    const admin = addUser('admin', 'admin')
    const bob = addUser('bob', 'user')

    expect(getBootstrapAdminId(db)).toBe(admin)
    expect(resolveUserScope(db, admin)).toEqual({ id: admin, username: 'admin', role: 'admin', isBootstrapAdmin: true, settings: expect.any(Object) })
    expect(resolveUserScope(db, String(bob))).toEqual({ id: bob, username: 'bob', role: 'user', isBootstrapAdmin: false, settings: expect.any(Object) })
  })

  it('detects multi-user mode once a second user exists', () => {
    addUser('admin', 'admin')
    expect(isMultiUser(db)).toBe(false)
    addUser('bob', 'user')
    expect(isMultiUser(db)).toBe(true)
  })

  it('returns null for unknown and pseudo identities', () => {
    addUser('admin', 'admin')
    expect(resolveUserScope(db, 99)).toBeNull()
    expect(resolveUserScope(db, 'telegram-123')).toBeNull()
  })
})
