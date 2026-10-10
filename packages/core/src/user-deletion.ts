import fs from 'node:fs'
import path from 'node:path'
import type { Database } from './database.js'
import { listEmailAccounts, deleteEmailAccount } from './email-account-store.js'
import { getUploadsDir, parseUploadsMetadata } from './uploads.js'

export interface UserPurgeResult {
  /** Tasks that were still running or paused when the purge started. */
  activeTaskIds: string[]
  cronjobIds: string[]
  deletedEmailAccounts: number
  deletedUploads: number
}

function tableExists(db: Database, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
}

/** Ids of every session that belongs to the user, including their task sessions. */
function collectSessionIds(db: Database, userId: number): string[] {
  const ids = new Set<string>()
  const rows = db.prepare('SELECT id FROM sessions WHERE user_id = ? OR session_user = ?')
    .all(userId, String(userId)) as Array<{ id: string }>
  for (const row of rows) ids.add(row.id)
  const taskSessions = db.prepare('SELECT session_id FROM tasks WHERE owner_user_id = ? AND session_id IS NOT NULL')
    .all(userId) as Array<{ session_id: string }>
  for (const row of taskSessions) ids.add(row.session_id)
  return [...ids]
}

function removeUploads(db: Database, userId: number): number {
  const uploadsDir = path.resolve(getUploadsDir())
  const rows = db.prepare(
    `SELECT metadata FROM chat_messages WHERE user_id = ? AND metadata IS NOT NULL AND (
      metadata LIKE '%"relativePath"%' OR metadata LIKE '%"files"%'
    )`,
  ).all(userId) as Array<{ metadata: string | null }>
  let deleted = 0
  for (const row of rows) {
    for (const file of parseUploadsMetadata(row.metadata)) {
      const absolutePath = path.resolve(uploadsDir, file.relativePath)
      if (absolutePath.startsWith(uploadsDir + path.sep) && fs.existsSync(absolutePath)) {
        fs.rmSync(absolutePath, { force: true })
        deleted += 1
      }
    }
  }
  return deleted
}

export function listUserActiveTaskIds(db: Database, userId: number): string[] {
  return (db.prepare("SELECT id FROM tasks WHERE owner_user_id = ? AND status IN ('running', 'paused')")
    .all(userId) as Array<{ id: string }>).map(row => row.id)
}

export function listUserCronjobIds(db: Database, userId: number): string[] {
  return (db.prepare('SELECT id FROM scheduled_tasks WHERE owner_user_id = ?')
    .all(userId) as Array<{ id: string }>).map(row => row.id)
}

/**
 * Removes everything a soft-deleted user owns except sessions and token usage,
 * and marks the user row deleted. Running tasks must be stopped and cronjobs
 * unregistered by the caller beforehand.
 */
export function purgeUserData(db: Database, userId: number): UserPurgeResult {
  const activeTaskIds = listUserActiveTaskIds(db, userId)
  const cronjobIds = listUserCronjobIds(db, userId)

  let deletedEmailAccounts = 0
  const accountIds = listEmailAccounts({ ownerUserId: userId }).map(account => account.id)
  for (const id of accountIds) {
    if (deleteEmailAccount(id)) deletedEmailAccounts += 1
  }

  const deletedUploads = removeUploads(db, userId)
  const sessionIds = collectSessionIds(db, userId)
  const taskIds = (db.prepare('SELECT id FROM tasks WHERE owner_user_id = ?').all(userId) as Array<{ id: string }>)
    .map(row => row.id)

  db.transaction(() => {
    for (const sessionId of sessionIds) {
      db.prepare('DELETE FROM chat_messages WHERE session_id = ?').run(sessionId)
      db.prepare('DELETE FROM tool_calls WHERE session_id = ?').run(sessionId)
    }
    db.prepare('DELETE FROM chat_messages WHERE user_id = ?').run(userId)
    db.prepare('DELETE FROM memories WHERE user_id = ?').run(userId)
    if (tableExists(db, 'task_tool_journal')) {
      for (const taskId of taskIds) db.prepare('DELETE FROM task_tool_journal WHERE task_id = ?').run(taskId)
    }
    db.prepare('DELETE FROM tasks WHERE owner_user_id = ?').run(userId)
    db.prepare('DELETE FROM scheduled_tasks WHERE owner_user_id = ?').run(userId)
    if (tableExists(db, 'email_send_log')) {
      db.prepare('DELETE FROM email_send_log WHERE owner_user_id = ?').run(userId)
    }
    db.prepare("UPDATE telegram_users SET user_id = NULL, updated_at = datetime('now') WHERE user_id = ?").run(userId)
    db.prepare(
      "UPDATE users SET deleted_at = COALESCE(deleted_at, datetime('now')), telegram_id = NULL, updated_at = datetime('now') WHERE id = ?",
    ).run(userId)
  })()

  return { activeTaskIds, cronjobIds, deletedEmailAccounts, deletedUploads }
}
