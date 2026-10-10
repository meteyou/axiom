import fs from 'node:fs'
import path from 'node:path'
import type { Database } from './database.js'
import { getWorkspaceDir } from './workspace.js'
import { resolveEffectiveSettings, type EffectiveUserSettings } from './user-settings.js'

export type UserRole = 'admin' | 'user'

export interface UserPaths {
  /** Personal folder (`/data/users/<name>`); null for the bootstrap admin, who keeps the legacy locations. */
  userDir: string | null
  profile: string
  dailyDir: string
  heartbeatFile: string
  workspace: string
}

export interface UserScope {
  id: number
  username: string
  role: UserRole
  isBootstrapAdmin: boolean
  paths: UserPaths
  settings: EffectiveUserSettings
}

interface UserRow {
  id: number
  username: string
  role: string
}

const USERNAME_PATTERN = /^[A-Za-z0-9]+$/

export function isValidUsername(username: string): boolean {
  return USERNAME_PATTERN.test(username)
}

function dataDir(): string {
  return process.env.DATA_DIR ?? '/data'
}

export function getUsersDir(): string {
  return path.join(dataDir(), 'users')
}

export function resolveUserPaths(username: string, isBootstrapAdmin: boolean): UserPaths {
  if (isBootstrapAdmin) {
    return {
      userDir: null,
      profile: path.join(dataDir(), 'memory', 'users', `${username}.md`),
      dailyDir: path.join(dataDir(), 'memory', 'daily'),
      heartbeatFile: path.join(dataDir(), 'config', 'HEARTBEAT.md'),
      workspace: getWorkspaceDir(),
    }
  }
  const userDir = path.join(getUsersDir(), username)
  return {
    userDir,
    profile: path.join(userDir, 'PROFILE.md'),
    dailyDir: path.join(userDir, 'daily'),
    heartbeatFile: path.join(userDir, 'HEARTBEAT.md'),
    workspace: path.join(getWorkspaceDir(), username),
  }
}

/** Returns the reason a new user cannot get this name, or null when it is free to use. */
export function checkUsernameAvailable(username: string): string | null {
  if (!isValidUsername(username)) return 'Username may only contain letters and digits'
  const { userDir, workspace } = resolveUserPaths(username, false)
  if (fs.existsSync(workspace)) return `A folder named "${username}" already exists in the workspace`
  if (userDir && fs.existsSync(userDir)) return `A personal folder for "${username}" already exists`
  return null
}

export interface UserFolderTemplates {
  profile: string
  heartbeat: string
}

/** Creates the personal folder and workspace of a non-bootstrap user. Idempotent. */
export function createUserFolders(paths: UserPaths, templates: UserFolderTemplates): void {
  if (!paths.userDir) return
  fs.mkdirSync(paths.dailyDir, { recursive: true })
  fs.mkdirSync(paths.workspace, { recursive: true })
  if (!fs.existsSync(paths.profile)) fs.writeFileSync(paths.profile, templates.profile, 'utf-8')
  if (!fs.existsSync(paths.heartbeatFile)) fs.writeFileSync(paths.heartbeatFile, templates.heartbeat, 'utf-8')
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
  const identity = {
    id: row.id,
    username: row.username,
    role: toRole(row.role),
    isBootstrapAdmin: row.id === getBootstrapAdminId(db),
  }
  return {
    ...identity,
    paths: resolveUserPaths(identity.username, identity.isBootstrapAdmin),
    settings: resolveEffectiveSettings(db, identity),
  }
}
