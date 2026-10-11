import fs from 'node:fs'
import path from 'node:path'
import type { Database } from './database.js'
import { isValidUsername } from './username.js'
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

function dataDir(): string {
  return process.env.DATA_DIR ?? '/data'
}

function getUsersDir(): string {
  return path.join(dataDir(), 'users')
}

function legacyProfilesDir(): string {
  return path.join(dataDir(), 'memory', 'users')
}

export function resolveUserPaths(username: string, isBootstrapAdmin: boolean): UserPaths {
  if (isBootstrapAdmin) {
    return {
      userDir: null,
      profile: path.join(legacyProfilesDir(), `${username}.md`),
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

/**
 * Moves the profiles of accounts from before multi-user support from the shared
 * `/data/memory/users/<name>.md` into their personal folder. Idempotent; an
 * existing personal profile is never overwritten. Returns the moved usernames.
 */
export function migrateLegacyUserProfiles(db: Database): string[] {
  const bootstrapAdminId = getBootstrapAdminId(db)
  if (bootstrapAdminId === null) return []

  const legacyDir = legacyProfilesDir()
  const rows = db.prepare('SELECT username FROM users WHERE deleted_at IS NULL AND id != ?').all(bootstrapAdminId) as Array<{ username: string }>
  const moved: string[] = []
  for (const { username } of rows) {
    const legacyProfile = path.join(legacyDir, `${username}.md`)
    const { userDir, profile } = resolveUserPaths(username, false)
    // Legacy names were never validated; `..` or `a/b` would resolve outside both folders.
    if (path.dirname(legacyProfile) !== legacyDir || !userDir || path.basename(userDir) !== username) continue
    if (!fs.existsSync(legacyProfile) || fs.existsSync(profile)) continue

    fs.mkdirSync(userDir, { recursive: true })
    fs.copyFileSync(legacyProfile, profile, fs.constants.COPYFILE_EXCL)
    fs.rmSync(legacyProfile)
    moved.push(username)
  }
  return moved
}

/**
 * Records that Axiom created the user's workspace (see `checkUsernameAvailable`),
 * which is what allows deleting the user to remove it.
 */
export function markWorkspaceProvisioned(db: Database, userId: number): void {
  db.prepare('UPDATE users SET workspace_provisioned = 1 WHERE id = ?').run(userId)
}

function toRole(role: string): UserRole {
  return role === 'admin' ? 'admin' : 'user'
}

/**
 * The legacy owner: the admin with the lowest id, or null without any admin.
 * Restricted to admins: instances from before multi-user support may have
 * demoted their first account, and the legacy owner manages the global
 * secrets and the shared legacy folders.
 */
export function getBootstrapAdminId(db: Database): number | null {
  const row = db.prepare("SELECT MIN(id) AS id FROM users WHERE role = 'admin'").get() as { id: number | null } | undefined
  return row?.id ?? null
}

export function isMultiUser(db: Database): boolean {
  const row = db.prepare('SELECT COUNT(*) AS count FROM users WHERE deleted_at IS NULL').get() as { count: number }
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
  const row = db.prepare('SELECT id, username, role FROM users WHERE id = ? AND deleted_at IS NULL').get(numericId) as UserRow | undefined
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
