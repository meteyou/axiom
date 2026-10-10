import { Router } from 'express'
import type { NextFunction, Response } from 'express'
import fs from 'node:fs'
import bcrypt from 'bcrypt'
import {
  checkUsernameAvailable,
  createUserFolders,
  getDefaultHeartbeatContent,
  getBootstrapAdminId,
  getUserProfileTemplate,
  isValidTimezone,
  listUserActiveTaskIds,
  listUserCronjobIds,
  purgeUserData,
  resolveUserPaths,
  resolveUserScope,
} from '@axiom/core'
import type { AgentCore, Database, TaskRuntimeBoundary } from '@axiom/core'
import { issueTokens, jwtMiddleware, revokeUserSessions } from '../auth.js'
import type { AuthenticatedRequest } from '../auth.js'

const SALT_ROUNDS = 10

interface UserRow {
  id: number
  username: string
  role: string
  telegram_id: string | null
  created_at: string
  updated_at: string
}

export interface UsersRouterOptions {
  db: Database
  getAgentCore?: () => AgentCore | null
  getTaskRuntime?: () => TaskRuntimeBoundary | null
  abortUserTurns?: (userId: number) => void
}

export function createUsersRouter(options: UsersRouterOptions | Database): Router {
  const db = 'db' in options ? options.db : options
  const getAgentCore = 'db' in options ? options.getAgentCore : undefined
  const getTaskRuntime = 'db' in options ? options.getTaskRuntime : undefined
  const abortUserTurns = 'db' in options ? options.abortUserTurns : undefined
  const router = Router()

  router.use(jwtMiddleware)

  const requireAdmin = (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (req.user?.role !== 'admin') {
      res.status(403).json({ error: 'Admin access required' })
      return
    }
    next()
  }

  /**
   * GET /api/users — list users (admins: all; regular users: only themselves)
   */
  router.get('/', (req: AuthenticatedRequest, res) => {
    try {
      const columns = 'id, username, role, telegram_id, created_at, updated_at'
      const rows = (req.user?.role === 'admin'
        ? db.prepare(`SELECT ${columns} FROM users WHERE deleted_at IS NULL ORDER BY id`).all()
        : db.prepare(`SELECT ${columns} FROM users WHERE id = ?`).all(req.user?.userId)) as UserRow[]

      const users = rows.map(row => ({
        id: row.id,
        username: row.username,
        role: row.role,
        telegramId: row.telegram_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }))

      res.json({ users })
    } catch (err) {
      res.status(500).json({ error: `Failed to list users: ${(err as Error).message}` })
    }
  })

  /**
   * PUT /api/users/me/password — change own password; all other logins are invalidated
   * and a fresh token pair is returned for the current session.
   */
  router.put('/me/password', (req: AuthenticatedRequest, res) => {
    const { currentPassword, newPassword } = req.body as {
      currentPassword?: string
      newPassword?: string
    }
    const userId = req.user!.userId

    if (!currentPassword || !newPassword) {
      res.status(400).json({ error: 'Current and new password are required' })
      return
    }
    if (newPassword.length < 4) {
      res.status(400).json({ error: 'Password must be at least 4 characters' })
      return
    }

    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId) as
      | { password_hash: string }
      | undefined
    if (!row || !bcrypt.compareSync(currentPassword, row.password_hash)) {
      res.status(403).json({ error: 'Current password is incorrect' })
      return
    }

    try {
      db.prepare(
        "UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(bcrypt.hashSync(newPassword, SALT_ROUNDS), userId)
      revokeUserSessions(db, userId)
      res.json(issueTokens(db, userId))
    } catch (err) {
      res.status(500).json({ error: `Failed to change password: ${(err as Error).message}` })
    }
  })

  router.use(requireAdmin)

  /**
   * POST /api/users — create user
   */
  router.post('/', (req: AuthenticatedRequest, res) => {
    const { username, password, role, language, timezone } = req.body as {
      username?: string
      password?: string
      role?: string
      language?: string | null
      timezone?: string | null
    }

    if (!username?.trim()) {
      res.status(400).json({ error: 'Username is required' })
      return
    }

    if (!password || password.length < 4) {
      res.status(400).json({ error: 'Password must be at least 4 characters' })
      return
    }

    const userRole = role === 'admin' ? 'admin' : 'user'

    const languageValue = typeof language === 'string' ? language.trim() : ''
    if (languageValue.length > 64) {
      res.status(400).json({ error: 'Language is too long' })
      return
    }
    const timezoneValue = typeof timezone === 'string' ? timezone.trim() : ''
    if (timezoneValue && !isValidTimezone(timezoneValue)) {
      res.status(400).json({ error: `Invalid timezone: ${timezoneValue}` })
      return
    }

    // Check for duplicate username
    const existing = db.prepare('SELECT id, deleted_at FROM users WHERE username = ?').get(username.trim()) as
      | { id: number; deleted_at: string | null }
      | undefined
    if (existing?.deleted_at) {
      res.status(409).json({ error: 'Username belongs to a deleted user and stays reserved' })
      return
    }
    if (existing) {
      res.status(409).json({ error: 'Username already exists' })
      return
    }

    const name = username.trim()
    const unavailable = checkUsernameAvailable(name)
    if (unavailable) {
      res.status(400).json({ error: unavailable })
      return
    }

    try {
      const hash = bcrypt.hashSync(password, SALT_ROUNDS)
      const result = db.prepare(
        'INSERT INTO users (username, password_hash, role, language, timezone) VALUES (?, ?, ?, ?, ?)'
      ).run(
        name,
        hash,
        userRole,
        userRole === 'user' ? languageValue || null : null,
        userRole === 'user' ? timezoneValue || null : null,
      )

      const scope = resolveUserScope(db, Number(result.lastInsertRowid))
      if (scope) {
        try {
          createUserFolders(scope.paths, {
            profile: getUserProfileTemplate(scope.username),
            heartbeat: getDefaultHeartbeatContent(),
          })
        } catch (err) {
          // Roll back so a retry is not blocked by a half-created user (409 / folder-exists check).
          db.prepare('DELETE FROM users WHERE id = ?').run(result.lastInsertRowid)
          if (scope.paths.userDir) {
            fs.rmSync(scope.paths.userDir, { recursive: true, force: true })
            fs.rmSync(scope.paths.workspace, { recursive: true, force: true })
          }
          throw err
        }
      }

      const user = db.prepare(
        'SELECT id, username, role, telegram_id, created_at, updated_at FROM users WHERE id = ?'
      ).get(result.lastInsertRowid) as UserRow

      res.status(201).json({
        user: {
          id: user.id,
          username: user.username,
          role: user.role,
          telegramId: user.telegram_id,
          createdAt: user.created_at,
          updatedAt: user.updated_at,
        },
      })
    } catch (err) {
      res.status(500).json({ error: `Failed to create user: ${(err as Error).message}` })
    }
  })

  /**
   * PUT /api/users/:id — update user (change role, reset password)
   */
  router.put('/:id', (req: AuthenticatedRequest, res) => {
    const rawId = req.params.id
    const id = parseInt(Array.isArray(rawId) ? rawId[0] : rawId, 10)
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid user ID' })
      return
    }

    const existing = db.prepare(
      'SELECT id, username, role FROM users WHERE id = ? AND deleted_at IS NULL'
    ).get(id) as UserRow | undefined

    if (!existing) {
      res.status(404).json({ error: 'User not found' })
      return
    }

    const { role, password } = req.body as {
      role?: string
      password?: string
    }

    if (password && password.length < 4) {
      res.status(400).json({ error: 'Password must be at least 4 characters' })
      return
    }

    const newRole = role === undefined ? undefined : role === 'admin' ? 'admin' : 'user'
    if (newRole === 'user' && id === getBootstrapAdminId(db)) {
      res.status(400).json({ error: 'The bootstrap admin cannot be demoted' })
      return
    }

    try {
      let revoke = false
      if (newRole !== undefined) {
        db.prepare(
          "UPDATE users SET role = ?, updated_at = datetime('now') WHERE id = ?"
        ).run(newRole, id)
        if (newRole !== existing.role) revoke = true
      }

      if (password) {
        revoke = true
        const hash = bcrypt.hashSync(password, SALT_ROUNDS)
        db.prepare(
          "UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?"
        ).run(hash, id)
      }

      if (revoke) revokeUserSessions(db, id)

      const updated = db.prepare(
        'SELECT id, username, role, telegram_id, created_at, updated_at FROM users WHERE id = ?'
      ).get(id) as UserRow

      res.json({
        user: {
          id: updated.id,
          username: updated.username,
          role: updated.role,
          telegramId: updated.telegram_id,
          createdAt: updated.created_at,
          updatedAt: updated.updated_at,
        },
      })
    } catch (err) {
      res.status(500).json({ error: `Failed to update user: ${(err as Error).message}` })
    }
  })

  /**
   * DELETE /api/users/:id — soft delete with cascade (cannot delete self or the bootstrap admin).
   * `?deleteFiles=false` keeps the personal folder and workspace.
   */
  router.delete('/:id', (req: AuthenticatedRequest, res) => {
    const rawId = req.params.id
    const id = parseInt(Array.isArray(rawId) ? rawId[0] : rawId, 10)
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid user ID' })
      return
    }

    if (req.user?.userId === id) {
      res.status(400).json({ error: 'Cannot delete your own account' })
      return
    }

    if (id === getBootstrapAdminId(db)) {
      res.status(400).json({ error: 'The bootstrap admin cannot be deleted' })
      return
    }

    // Already deleted users are accepted so a cascade that failed halfway can be resumed; every step is idempotent.
    const existing = db.prepare('SELECT id, username FROM users WHERE id = ?').get(id) as
      | { id: number; username: string }
      | undefined
    if (!existing) {
      res.status(404).json({ error: 'User not found' })
      return
    }

    const deleteFilesParam = req.query.deleteFiles
    const deleteFiles = !(deleteFilesParam === 'false' || deleteFilesParam === '0')

    try {
      const paths = resolveUserPaths(existing.username, false)
      const taskRuntime = getTaskRuntime?.() ?? null

      // Marked first so results of the aborted tasks are not injected into the user's agent.
      db.prepare("UPDATE users SET deleted_at = COALESCE(deleted_at, datetime('now')) WHERE id = ?").run(id)
      revokeUserSessions(db, id)
      abortUserTurns?.(id)

      for (const taskId of listUserActiveTaskIds(db, id)) {
        taskRuntime?.tasks.abort(taskId, 'User deleted')
      }
      for (const cronjobId of listUserCronjobIds(db, id)) {
        taskRuntime?.schedules.unregister(cronjobId)
      }

      getAgentCore?.()?.discardUser(String(id))
      purgeUserData(db, id)

      if (deleteFiles && paths.userDir) {
        fs.rmSync(paths.userDir, { recursive: true, force: true })
        fs.rmSync(paths.workspace, { recursive: true, force: true })
      }

      res.json({ message: 'User deleted' })
    } catch (err) {
      res.status(500).json({ error: `Failed to delete user: ${(err as Error).message}` })
    }
  })

  return router
}
