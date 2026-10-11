import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import { checkUsernameAvailable, createUserFolders, getBootstrapAdminId, isMultiUser, migrateLegacyUserProfiles, resolveUserPaths, resolveUserScope } from './user-scope.js'

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

  it('skips a demoted first account when picking the bootstrap admin', () => {
    const demoted = addUser('first', 'user')
    const admin = addUser('admin', 'admin')

    expect(getBootstrapAdminId(db)).toBe(admin)
    expect(resolveUserScope(db, demoted)?.isBootstrapAdmin).toBe(false)
    expect(resolveUserScope(db, demoted)?.paths.userDir).not.toBeNull()
  })

  it('treats the lowest user id as bootstrap admin', () => {
    const admin = addUser('admin', 'admin')
    const bob = addUser('bob', 'user')

    expect(getBootstrapAdminId(db)).toBe(admin)
    expect(resolveUserScope(db, admin)).toEqual({ id: admin, username: 'admin', role: 'admin', isBootstrapAdmin: true, paths: expect.any(Object), settings: expect.any(Object) })
    expect(resolveUserScope(db, String(bob))).toEqual({ id: bob, username: 'bob', role: 'user', isBootstrapAdmin: false, paths: expect.any(Object), settings: expect.any(Object) })
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

describe('user paths', () => {
  let dataDir: string
  let originalDataDir: string | undefined
  let originalWorkspaceDir: string | undefined

  beforeEach(() => {
    originalDataDir = process.env.DATA_DIR
    originalWorkspaceDir = process.env.WORKSPACE_DIR
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'user-scope-'))
    process.env.DATA_DIR = path.join(dataDir, 'data')
    process.env.WORKSPACE_DIR = path.join(dataDir, 'workspace')
  })

  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = originalDataDir
    if (originalWorkspaceDir === undefined) delete process.env.WORKSPACE_DIR
    else process.env.WORKSPACE_DIR = originalWorkspaceDir
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it('keeps the legacy locations for the bootstrap admin', () => {
    expect(resolveUserPaths('admin', true)).toEqual({
      userDir: null,
      profile: path.join(dataDir, 'data/memory/users/admin.md'),
      dailyDir: path.join(dataDir, 'data/memory/daily'),
      heartbeatFile: path.join(dataDir, 'data/config/HEARTBEAT.md'),
      workspace: path.join(dataDir, 'workspace'),
    })
  })

  it('resolves personal folders for every other user', () => {
    expect(resolveUserPaths('bob', false)).toEqual({
      userDir: path.join(dataDir, 'data/users/bob'),
      profile: path.join(dataDir, 'data/users/bob/PROFILE.md'),
      dailyDir: path.join(dataDir, 'data/users/bob/daily'),
      heartbeatFile: path.join(dataDir, 'data/users/bob/HEARTBEAT.md'),
      workspace: path.join(dataDir, 'workspace/bob'),
    })
  })

  it('rejects non-alphanumeric usernames and existing folders', () => {
    expect(checkUsernameAvailable('bob')).toBeNull()
    expect(checkUsernameAvailable('b/b')).not.toBeNull()
    expect(checkUsernameAvailable('../x')).not.toBeNull()
    expect(checkUsernameAvailable('')).not.toBeNull()

    fs.mkdirSync(path.join(dataDir, 'workspace/repo'), { recursive: true })
    expect(checkUsernameAvailable('repo')).not.toBeNull()
    fs.mkdirSync(path.join(dataDir, 'data/users/carol'), { recursive: true })
    expect(checkUsernameAvailable('carol')).not.toBeNull()
  })

  it('creates the personal folder and workspace from templates', () => {
    const paths = resolveUserPaths('bob', false)
    createUserFolders(paths, { profile: '# Bob', heartbeat: '# HB' })

    expect(fs.readFileSync(paths.profile, 'utf-8')).toBe('# Bob')
    expect(fs.readFileSync(paths.heartbeatFile, 'utf-8')).toBe('# HB')
    expect(fs.statSync(paths.dailyDir).isDirectory()).toBe(true)
    expect(fs.statSync(paths.workspace).isDirectory()).toBe(true)
  })

  describe('legacy profile migration', () => {
    let db: Database
    const legacyProfile = (name: string) => path.join(dataDir, 'data/memory/users', `${name}.md`)
    const writeLegacy = (name: string, content: string) => {
      fs.mkdirSync(path.join(dataDir, 'data/memory/users'), { recursive: true })
      fs.writeFileSync(legacyProfile(name), content, 'utf-8')
    }
    const addUser = (username: string, role: string) =>
      Number(db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(username, 'h', role).lastInsertRowid)

    beforeEach(() => {
      db = initDatabase(':memory:')
    })

    afterEach(() => {
      db.close()
    })

    it('moves profiles of existing users into their personal folder and keeps the bootstrap admin', () => {
      addUser('admin', 'admin')
      addUser('bob', 'user')
      writeLegacy('admin', '# Admin profile')
      writeLegacy('bob', '# Bob profile\nLikes tea')

      expect(migrateLegacyUserProfiles(db)).toEqual(['bob'])

      expect(fs.readFileSync(path.join(dataDir, 'data/users/bob/PROFILE.md'), 'utf-8')).toBe('# Bob profile\nLikes tea')
      expect(fs.existsSync(legacyProfile('bob'))).toBe(false)
      expect(fs.readFileSync(legacyProfile('admin'), 'utf-8')).toBe('# Admin profile')
      expect(migrateLegacyUserProfiles(db)).toEqual([])
    })

    it('never overwrites an existing personal profile', () => {
      addUser('admin', 'admin')
      addUser('bob', 'user')
      writeLegacy('bob', '# Old')
      fs.mkdirSync(path.join(dataDir, 'data/users/bob'), { recursive: true })
      fs.writeFileSync(path.join(dataDir, 'data/users/bob/PROFILE.md'), '# Current', 'utf-8')

      expect(migrateLegacyUserProfiles(db)).toEqual([])
      expect(fs.readFileSync(path.join(dataDir, 'data/users/bob/PROFILE.md'), 'utf-8')).toBe('# Current')
      expect(fs.readFileSync(legacyProfile('bob'), 'utf-8')).toBe('# Old')
    })

    it('skips deleted users and names that resolve outside the profile folders', () => {
      addUser('admin', 'admin')
      const gone = addUser('gone', 'user')
      db.prepare("UPDATE users SET deleted_at = datetime('now') WHERE id = ?").run(gone)
      addUser('..', 'user')
      writeLegacy('gone', '# Gone')
      writeLegacy('..', '# Dots')

      expect(migrateLegacyUserProfiles(db)).toEqual([])
      expect(fs.existsSync(legacyProfile('gone'))).toBe(true)
      expect(fs.existsSync(path.join(dataDir, 'data/PROFILE.md'))).toBe(false)
    })
  })
})
