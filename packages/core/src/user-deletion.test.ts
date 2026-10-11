import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import { createEmailAccount, listEmailAccounts } from './email-account-store.js'
import { initEmailSendLogTable, createEmailSendLogEntry, listEmailSendLog } from './email-send-log.js'
import { saveUpload, serializeUploadsMetadata } from './uploads.js'
import { logToolCall } from './token-logger.js'
import { purgeUserData, removeUserFolders } from './user-deletion.js'
import { saveContextCompaction } from './compaction-store.js'
import { saveContextCompactionNotice } from './context-compaction-notice.js'
import { markWorkspaceProvisioned } from './user-scope.js'

describe('purgeUserData', () => {
  let db: Database
  let dir: string
  const previous = process.env.DATA_DIR

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-user-deletion-'))
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true })
    process.env.DATA_DIR = dir
    db = initDatabase(':memory:')
    initEmailSendLogTable(db)
    db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1, 'admin', 'h', 'admin'), (2, 'alice', 'h', 'user')").run()
  })

  afterEach(() => {
    if (previous === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previous
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('removes email accounts, send log and referenced uploads of the user only', () => {
    const input = {
      name: 'Mail', imapHost: 'h', imapPort: 1, imapUser: 'u', imapPassword: 'p',
      smtpHost: 'h', smtpPort: 1, smtpUser: 'u', smtpPassword: 'p',
    }
    createEmailAccount(input, 2)
    createEmailAccount(input, 1)
    createEmailSendLogEntry(db, { accountId: 'a', accountName: 'Mail', ownerUserId: 2, status: 'sent', recipientsTo: ['x@y.z'], subject: 's', bodyText: 'b' } as never)

    const upload = saveUpload({ buffer: Buffer.from('x'), originalName: 'a.txt', mimeType: 'text/plain', source: 'web' })
    db.prepare("INSERT INTO sessions (id, user_id) VALUES ('s2', 2)").run()
    db.prepare("INSERT INTO chat_messages (session_id, user_id, role, content, metadata) VALUES ('s2', 2, 'user', 'hi', ?)")
      .run(serializeUploadsMetadata([upload]))

    const result = purgeUserData(db, 2)

    expect(result.deletedEmailAccounts).toBe(1)
    expect(listEmailAccounts({ ownerUserId: 2 })).toHaveLength(0)
    expect(listEmailAccounts({ ownerUserId: 1 })).toHaveLength(1)
    expect(listEmailSendLog(db, {})).toHaveLength(0)
    expect(fs.existsSync(path.join(dir, 'uploads', upload.relativePath))).toBe(false)
    expect((db.prepare('SELECT deleted_at FROM users WHERE id = 2').get() as { deleted_at: string | null }).deleted_at).not.toBeNull()
    expect((db.prepare('SELECT deleted_at FROM users WHERE id = 1').get() as { deleted_at: string | null }).deleted_at).toBeNull()
  })

  it('drops tool calls logged by aborted runs after the purge', () => {
    db.prepare("INSERT INTO sessions (id, user_id) VALUES ('s1', 1), ('s2', 2)").run()
    purgeUserData(db, 2)

    const record = { toolName: 'shell', input: '{}', output: '{}', durationMs: 1 }
    expect(logToolCall(db, { ...record, sessionId: 's2' })).toBe(0)
    expect(logToolCall(db, { ...record, sessionId: 's1' })).toBeGreaterThan(0)
    expect(db.prepare('SELECT session_id FROM tool_calls').all()).toEqual([{ session_id: 's1' }])
  })

  it('removes compaction summaries and drops notices written after the purge', () => {
    db.prepare("INSERT INTO sessions (id, user_id) VALUES ('s1', 1), ('s2', 2)").run()
    const record = {
      scope: 'interactive' as const, reason: 'threshold' as const, provider: 'p', model: 'm',
      tokensBefore: 10, tokensAfter: 5, summary: 'private', firstKeptTimestamp: null,
      promptTokens: 0, completionTokens: 0, cacheRead: 0, cacheWrite: 0, estimatedCost: 0,
    }
    saveContextCompaction(db, { ...record, sessionId: 's1' })
    saveContextCompaction(db, { ...record, sessionId: 's2' })

    purgeUserData(db, 2)

    expect(db.prepare('SELECT session_id FROM context_compactions').all()).toEqual([{ session_id: 's1' }])
    expect(saveContextCompaction(db, { ...record, sessionId: 's2' })).toBe(0)
    const info = { compactionId: 'c', status: 'completed' as const, reason: 'manual' as const, tokensBefore: 1, occurredAt: '' }
    expect(saveContextCompactionNotice(db, { sessionId: 's2', userId: 2, info }).messageId).toBeUndefined()
    expect(saveContextCompactionNotice(db, { sessionId: 's2', userId: null, info }).messageId).toBeUndefined()
    expect(saveContextCompactionNotice(db, { sessionId: 's1', userId: 1, info }).messageId).toBeTypeOf('number')
  })
})

describe('removeUserFolders', () => {
  let db: Database
  let dir: string
  let workspaceDir: string
  const previous = { data: process.env.DATA_DIR, workspace: process.env.WORKSPACE_DIR }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-user-folders-'))
    workspaceDir = path.join(dir, 'workspace')
    process.env.DATA_DIR = dir
    process.env.WORKSPACE_DIR = workspaceDir
    db = initDatabase(':memory:')
    db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1, 'admin', 'h', 'admin'), (2, 'alice', 'h', 'user'), (3, 'images', 'h', 'user'), (4, '..', 'h', 'user'), (5, 'john.doe', 'h', 'user')").run()
    for (const folder of ['users/alice', 'users/images', 'users/john.doe', 'workspace/alice', 'workspace/images/2025-01-01']) {
      fs.mkdirSync(path.join(dir, folder), { recursive: true })
    }
  })

  afterEach(() => {
    for (const [key, value] of [['DATA_DIR', previous.data], ['WORKSPACE_DIR', previous.workspace]] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('removes the personal folder and the workspace Axiom created for the user', () => {
    markWorkspaceProvisioned(db, 2)
    expect(removeUserFolders(db, 2)).toEqual({
      removed: [path.join(dir, 'users', 'alice'), path.join(workspaceDir, 'alice')],
      kept: [],
    })
    expect(fs.existsSync(path.join(workspaceDir, 'alice'))).toBe(false)
  })

  it('keeps a workspace folder Axiom did not create for the user', () => {
    expect(removeUserFolders(db, 3)).toEqual({
      removed: [path.join(dir, 'users', 'images')],
      kept: [path.join(workspaceDir, 'images')],
    })
    expect(fs.existsSync(path.join(workspaceDir, 'images', '2025-01-01'))).toBe(true)
  })

  it('never touches folders of invalid legacy usernames or the bootstrap admin', () => {
    markWorkspaceProvisioned(db, 4)
    markWorkspaceProvisioned(db, 5)
    expect(removeUserFolders(db, 4)).toEqual({ removed: [], kept: [] })
    expect(removeUserFolders(db, 5)).toEqual({ removed: [], kept: [path.join(dir, 'users', 'john.doe')] })
    expect(removeUserFolders(db, 1)).toEqual({ removed: [], kept: [] })
    expect(fs.existsSync(workspaceDir)).toBe(true)
    expect(fs.existsSync(path.join(dir, 'users'))).toBe(true)
  })
})
