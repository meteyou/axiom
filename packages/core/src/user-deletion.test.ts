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
import { purgeUserData } from './user-deletion.js'

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
})
