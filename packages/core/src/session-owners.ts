import type { Database } from './database.js'
import { getBootstrapAdminId } from './user-scope.js'

/**
 * Attributes sessions without `user_id` to an owner: the numeric `session_user`
 * of an existing user, the owner of the task running in the session, the
 * owner of the lineage parent, else the bootstrap admin. Idempotent.
 */
export function migrateSessionOwners(db: Database): void {
  const bootstrapAdminId = getBootstrapAdminId(db)
  if (bootstrapAdminId === null) return

  const orphans = db.prepare('SELECT id FROM sessions WHERE user_id IS NULL').all() as Array<{ id: string }>
  if (orphans.length === 0) return

  const userExists = db.prepare('SELECT 1 FROM users WHERE id = ?')
  const sessionRow = db.prepare('SELECT parent_session_id, user_id, session_user FROM sessions WHERE id = ?')
  const taskOwner = db.prepare('SELECT owner_user_id FROM tasks WHERE session_id = ? AND owner_user_id IS NOT NULL LIMIT 1')
  const setOwner = db.prepare('UPDATE sessions SET user_id = ? WHERE id = ?')

  const existingUser = (value: unknown): number | null => {
    const id = typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : null
    return id !== null && Number.isSafeInteger(id) && userExists.get(id) ? id : null
  }

  const resolveOwner = (sessionId: string): number | null => {
    let currentId: string | null = sessionId
    for (let depth = 0; currentId && depth < 10; depth++) {
      const row = sessionRow.get(currentId) as
        | { parent_session_id: string | null; user_id: number | null; session_user: string | null }
        | undefined
      if (!row) return null
      const owner = existingUser(row.user_id)
        ?? existingUser(row.session_user)
        ?? existingUser((taskOwner.get(currentId) as { owner_user_id: number } | undefined)?.owner_user_id)
      if (owner !== null) return owner
      currentId = row.parent_session_id
    }
    return null
  }

  db.transaction(() => {
    for (const orphan of orphans) {
      setOwner.run(resolveOwner(orphan.id) ?? bootstrapAdminId, orphan.id)
    }
  })()
}
