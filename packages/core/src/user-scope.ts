import type { Database } from './database.js'

export type UserRole = 'admin' | 'user'

export interface UserScope {
  id: number
  username: string
  role: UserRole
  isBootstrapAdmin: boolean
}

interface UserRow {
  id: number
  username: string
  role: string
}

function toRole(role: string): UserRole {
  return role === 'admin' ? 'admin' : 'user'
}

/** The legacy owner: the user with the lowest id, or null on an empty instance. */
export function getBootstrapAdminId(db: Database): number | null {
  const row = db.prepare('SELECT MIN(id) AS id FROM users').get() as { id: number | null } | undefined
  return row?.id ?? null
}

export function isMultiUser(db: Database): boolean {
  const row = db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }
  return row.count > 1
}

/**
 * Resolve a user's identity. Accepts the id as number or string; returns null
 * for non-numeric identities (e.g. `telegram-<id>` pseudo users) and for ids
 * that do not exist.
 */
export function resolveUserScope(db: Database, userId: number | string): UserScope | null {
  const numericId = typeof userId === 'number' ? userId : Number(userId)
  if (!Number.isSafeInteger(numericId)) return null
  const row = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(numericId) as UserRow | undefined
  if (!row) return null
  return {
    id: row.id,
    username: row.username,
    role: toRole(row.role),
    isBootstrapAdmin: row.id === getBootstrapAdminId(db),
  }
}
