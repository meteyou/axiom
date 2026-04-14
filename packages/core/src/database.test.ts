import { describe, it, expect, afterEach, vi } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { initDatabase, isValidUsername, validateUsername } from './database.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

describe('database', () => {
  const tmpFiles: string[] = []

  afterEach(() => {
    vi.restoreAllMocks()
    for (const f of tmpFiles) {
      for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(`${f}${suffix}`) } catch { /* ignore */ }
      }
    }
    tmpFiles.length = 0
  })

  function tmpDbPath(): string {
    const p = path.join(os.tmpdir(), `openagent-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
    tmpFiles.push(p)
    return p
  }

  function createLegacyDatabase(dbPath: string): void {
    const legacyDb = new BetterSqlite3(dbPath)
    legacyDb.pragma('foreign_keys = ON')
    legacyDb.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user'
      );

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        user_id INTEGER,
        source TEXT NOT NULL DEFAULT 'web',
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        ended_at TEXT,
        message_count INTEGER NOT NULL DEFAULT 0,
        summary_written INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );

      CREATE TABLE chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        user_id INTEGER,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'tool')),
        content TEXT NOT NULL,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
    `)

    legacyDb.prepare(
      'INSERT INTO users (username, password_hash) VALUES (?, ?)'
    ).run('legacy-user', 'hash')

    legacyDb.prepare(
      'INSERT INTO sessions (id, user_id, source, started_at, message_count, summary_written) VALUES (?, ?, ?, datetime(\'now\'), ?, ?)'
    ).run('legacy-session', 1, 'web', 2, 0)

    legacyDb.prepare(
      'INSERT INTO chat_messages (session_id, user_id, role, content) VALUES (?, ?, ?, ?)'
    ).run('legacy-session', 1, 'user', 'Legacy Übersicht message')

    legacyDb.prepare(
      'INSERT INTO chat_messages (session_id, user_id, role, content) VALUES (?, ?, ?, ?)'
    ).run('legacy-session', 1, 'assistant', 'Second legacy reply')

    legacyDb.close()
  }

  it('creates database with new schema, virtual tables, triggers, and indexes', () => {
    const db = initDatabase(tmpDbPath())

    const objects = db.prepare(
      "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
    ).all() as { type: string, name: string }[]

    const objectNames = new Set(objects.map(obj => `${obj.type}:${obj.name}`))
    expect(objectNames).toContain('table:token_usage')
    expect(objectNames).toContain('table:tool_calls')
    expect(objectNames).toContain('table:users')
    expect(objectNames).toContain('table:sessions')
    expect(objectNames).toContain('table:memories')
    expect(objectNames).toContain('table:memories_fts')
    expect(objectNames).toContain('table:chat_messages')
    expect(objectNames).toContain('table:chat_messages_fts')
    expect(objectNames).toContain('table:health_checks')
    expect(objectNames).toContain('index:idx_memories_user')
    expect(objectNames).toContain('index:idx_memories_timestamp')
    expect(objectNames).toContain('index:idx_memories_session')
    expect(objectNames).toContain('trigger:memories_fts_insert')
    expect(objectNames).toContain('trigger:memories_fts_delete')
    expect(objectNames).toContain('trigger:memories_fts_update')
    expect(objectNames).toContain('trigger:chat_messages_fts_insert')
    expect(objectNames).toContain('trigger:chat_messages_fts_delete')
    expect(objectNames).toContain('trigger:chat_messages_fts_update')

    const sessionCols = db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]
    expect(sessionCols.map(col => col.name)).toContain('prompt_tokens')
    expect(sessionCols.map(col => col.name)).toContain('completion_tokens')

    db.prepare(
      'INSERT INTO sessions (id, source) VALUES (?, ?)'
    ).run('fresh-session', 'web')

    const session = db.prepare(
      'SELECT prompt_tokens, completion_tokens FROM sessions WHERE id = ?'
    ).get('fresh-session') as { prompt_tokens: number, completion_tokens: number }
    expect(session.prompt_tokens).toBe(0)
    expect(session.completion_tokens).toBe(0)

    db.close()
  })

  it('migrates an existing database and backfills chat_messages_fts idempotently', () => {
    const dbPath = tmpDbPath()
    createLegacyDatabase(dbPath)

    let db = initDatabase(dbPath)

    const sessionCols = db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]
    expect(sessionCols.map(col => col.name)).toContain('prompt_tokens')
    expect(sessionCols.map(col => col.name)).toContain('completion_tokens')

    const migratedSession = db.prepare(
      'SELECT prompt_tokens, completion_tokens FROM sessions WHERE id = ?'
    ).get('legacy-session') as { prompt_tokens: number, completion_tokens: number }
    expect(migratedSession.prompt_tokens).toBe(0)
    expect(migratedSession.completion_tokens).toBe(0)

    const migratedObjects = db.prepare(
      "SELECT type, name FROM sqlite_master WHERE name IN ('memories', 'memories_fts', 'chat_messages_fts', 'chat_messages_fts_insert', 'chat_messages_fts_delete', 'chat_messages_fts_update') ORDER BY type, name"
    ).all() as { type: string, name: string }[]
    expect(migratedObjects).toEqual([
      { type: 'table', name: 'chat_messages_fts' },
      { type: 'table', name: 'memories' },
      { type: 'table', name: 'memories_fts' },
      { type: 'trigger', name: 'chat_messages_fts_delete' },
      { type: 'trigger', name: 'chat_messages_fts_insert' },
      { type: 'trigger', name: 'chat_messages_fts_update' },
    ])

    const backfilledRows = db.prepare(
      'SELECT rowid, content FROM chat_messages_fts ORDER BY rowid'
    ).all() as { rowid: number, content: string }[]
    expect(backfilledRows).toHaveLength(2)
    expect(backfilledRows[0].content).toBe('Legacy Übersicht message')
    expect(backfilledRows[1].content).toBe('Second legacy reply')

    db.close()

    db = initDatabase(dbPath)
    const backfilledCount = db.prepare('SELECT COUNT(*) as count FROM chat_messages_fts').get() as { count: number }
    expect(backfilledCount.count).toBe(2)

    const legacyMatches = db.prepare(
      "SELECT rowid FROM chat_messages_fts WHERE chat_messages_fts MATCH 'ubersicht'"
    ).all() as { rowid: number }[]
    expect(legacyMatches.map(row => row.rowid)).toEqual([1])

    db.close()
  })

  it('rebuilds FTS indexes only when the virtual tables are first created', () => {
    const execSpy = vi.spyOn(BetterSqlite3.prototype, 'exec')
    const dbPath = tmpDbPath()

    let db = initDatabase(dbPath)
    db.prepare(
      'INSERT INTO chat_messages (session_id, role, content) VALUES (?, ?, ?)'
    ).run('session-fts', 'user', 'hello world')
    db.prepare(
      'INSERT INTO memories (session_id, content) VALUES (?, ?)'
    ).run('session-fts', 'remember this')
    db.close()

    const firstMemoriesRebuildCount = execSpy.mock.calls.filter(([sql]) =>
      typeof sql === 'string' && sql.includes("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')")
    ).length
    const firstChatMessagesRebuildCount = execSpy.mock.calls.filter(([sql]) =>
      typeof sql === 'string' && sql.includes("INSERT INTO chat_messages_fts(chat_messages_fts) VALUES('rebuild')")
    ).length

    db = initDatabase(dbPath)

    const totalMemoriesRebuildCount = execSpy.mock.calls.filter(([sql]) =>
      typeof sql === 'string' && sql.includes("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')")
    ).length
    const totalChatMessagesRebuildCount = execSpy.mock.calls.filter(([sql]) =>
      typeof sql === 'string' && sql.includes("INSERT INTO chat_messages_fts(chat_messages_fts) VALUES('rebuild')")
    ).length

    expect(firstMemoriesRebuildCount).toBe(1)
    expect(firstChatMessagesRebuildCount).toBe(1)
    expect(totalMemoriesRebuildCount).toBe(1)
    expect(totalChatMessagesRebuildCount).toBe(1)

    const chatMatch = db.prepare(
      "SELECT rowid FROM chat_messages_fts WHERE chat_messages_fts MATCH 'hello'"
    ).all() as { rowid: number }[]
    expect(chatMatch).toHaveLength(1)

    const memoryMatch = db.prepare(
      "SELECT rowid FROM memories_fts WHERE memories_fts MATCH 'remember'"
    ).all() as { rowid: number }[]
    expect(memoryMatch).toHaveLength(1)

    db.close()
    execSpy.mockRestore()
  })

  it('backfills session token counters from existing token_usage rows', () => {
    const dbPath = tmpDbPath()
    const legacyDb = new BetterSqlite3(dbPath)
    legacyDb.pragma('foreign_keys = ON')
    legacyDb.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user'
      );

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        user_id INTEGER,
        source TEXT NOT NULL DEFAULT 'web',
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        ended_at TEXT,
        message_count INTEGER NOT NULL DEFAULT 0,
        summary_written INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );

      CREATE TABLE token_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        estimated_cost REAL NOT NULL DEFAULT 0.0,
        session_id TEXT
      );
    `)

    legacyDb.prepare(
      'INSERT INTO sessions (id, source) VALUES (?, ?)'
    ).run('legacy-with-usage', 'web')
    legacyDb.prepare(
      'INSERT INTO sessions (id, source) VALUES (?, ?)'
    ).run('legacy-without-usage', 'web')

    legacyDb.prepare(
      'INSERT INTO token_usage (provider, model, prompt_tokens, completion_tokens, estimated_cost, session_id) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('openai', 'gpt-4o', 100, 40, 0.001, 'legacy-with-usage')
    legacyDb.prepare(
      'INSERT INTO token_usage (provider, model, prompt_tokens, completion_tokens, estimated_cost, session_id) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('openai', 'gpt-4o-mini', 25, 10, 0.0002, 'legacy-with-usage')
    legacyDb.prepare(
      'INSERT INTO token_usage (provider, model, prompt_tokens, completion_tokens, estimated_cost) VALUES (?, ?, ?, ?, ?)'
    ).run('anthropic', 'claude-3-5-sonnet-20241022', 50, 20, 0.002)

    legacyDb.close()

    let db = initDatabase(dbPath)

    const backfilledSession = db.prepare(
      'SELECT prompt_tokens, completion_tokens FROM sessions WHERE id = ?'
    ).get('legacy-with-usage') as { prompt_tokens: number, completion_tokens: number }
    expect(backfilledSession.prompt_tokens).toBe(125)
    expect(backfilledSession.completion_tokens).toBe(50)

    const untouchedSession = db.prepare(
      'SELECT prompt_tokens, completion_tokens FROM sessions WHERE id = ?'
    ).get('legacy-without-usage') as { prompt_tokens: number, completion_tokens: number }
    expect(untouchedSession.prompt_tokens).toBe(0)
    expect(untouchedSession.completion_tokens).toBe(0)

    db.close()

    db = initDatabase(dbPath)
    const idempotentSession = db.prepare(
      'SELECT prompt_tokens, completion_tokens FROM sessions WHERE id = ?'
    ).get('legacy-with-usage') as { prompt_tokens: number, completion_tokens: number }
    expect(idempotentSession.prompt_tokens).toBe(125)
    expect(idempotentSession.completion_tokens).toBe(50)

    db.close()
  })

  it('can insert and query token_usage', () => {
    const db = initDatabase(tmpDbPath())

    db.prepare(
      'INSERT INTO token_usage (provider, model, prompt_tokens, completion_tokens) VALUES (?, ?, ?, ?)'
    ).run('openai', 'gpt-4', 100, 50)

    const rows = db.prepare('SELECT * FROM token_usage').all() as Record<string, unknown>[]
    expect(rows).toHaveLength(1)
    expect(rows[0].provider).toBe('openai')
    expect(rows[0].prompt_tokens).toBe(100)

    db.close()
  })

  it('keeps chat_messages_fts in sync on insert, update, and delete', () => {
    const db = initDatabase(tmpDbPath())

    const insertResult = db.prepare(
      "INSERT INTO chat_messages (session_id, role, content) VALUES (?, ?, ?)"
    ).run('session-fts', 'user', 'Initial message')
    const messageId = Number(insertResult.lastInsertRowid)

    let ftsRow = db.prepare(
      'SELECT rowid, content FROM chat_messages_fts WHERE rowid = ?'
    ).get(messageId) as { rowid: number, content: string } | undefined
    expect(ftsRow).toEqual({ rowid: messageId, content: 'Initial message' })

    db.prepare('UPDATE chat_messages SET content = ? WHERE id = ?').run('Updated Übersicht', messageId)

    ftsRow = db.prepare(
      'SELECT rowid, content FROM chat_messages_fts WHERE rowid = ?'
    ).get(messageId) as { rowid: number, content: string } | undefined
    expect(ftsRow).toEqual({ rowid: messageId, content: 'Updated Übersicht' })

    const matches = db.prepare(
      "SELECT rowid FROM chat_messages_fts WHERE chat_messages_fts MATCH 'ubersicht'"
    ).all() as { rowid: number }[]
    expect(matches.map(row => row.rowid)).toEqual([messageId])

    const prefixMatches = db.prepare(
      "SELECT rowid FROM chat_messages_fts WHERE chat_messages_fts MATCH 'über*'"
    ).all() as { rowid: number }[]
    expect(prefixMatches.map(row => row.rowid)).toEqual([messageId])

    db.prepare('DELETE FROM chat_messages WHERE id = ?').run(messageId)

    const deletedRow = db.prepare(
      'SELECT rowid FROM chat_messages_fts WHERE rowid = ?'
    ).get(messageId)
    expect(deletedRow).toBeUndefined()

    db.close()
  })

  it('keeps memories_fts in sync on insert, update, and delete', () => {
    const db = initDatabase(tmpDbPath())

    const insertResult = db.prepare(
      'INSERT INTO memories (session_id, content) VALUES (?, ?)'
    ).run('memory-session', 'Remember this detail')
    const memoryId = Number(insertResult.lastInsertRowid)

    let ftsRow = db.prepare(
      'SELECT rowid, content FROM memories_fts WHERE rowid = ?'
    ).get(memoryId) as { rowid: number, content: string } | undefined
    expect(ftsRow).toEqual({ rowid: memoryId, content: 'Remember this detail' })

    db.prepare('UPDATE memories SET content = ? WHERE id = ?').run('Updated memory detail', memoryId)
    ftsRow = db.prepare(
      'SELECT rowid, content FROM memories_fts WHERE rowid = ?'
    ).get(memoryId) as { rowid: number, content: string } | undefined
    expect(ftsRow).toEqual({ rowid: memoryId, content: 'Updated memory detail' })

    const matches = db.prepare(
      "SELECT rowid FROM memories_fts WHERE memories_fts MATCH 'updated'"
    ).all() as { rowid: number }[]
    expect(matches.map(row => row.rowid)).toEqual([memoryId])

    db.prepare('DELETE FROM memories WHERE id = ?').run(memoryId)
    const deletedRow = db.prepare(
      'SELECT rowid FROM memories_fts WHERE rowid = ?'
    ).get(memoryId)
    expect(deletedRow).toBeUndefined()

    db.close()
  })

  it('can insert and query users', () => {
    const db = initDatabase(tmpDbPath())

    db.prepare(
      'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)'
    ).run('admin', 'hash123', 'admin')

    const user = db.prepare('SELECT * FROM users WHERE username = ?').get('admin') as Record<string, unknown>
    expect(user.username).toBe('admin')
    expect(user.role).toBe('admin')

    db.close()
  })

  describe('username validation', () => {
    it('accepts valid alphanumeric usernames', () => {
      expect(isValidUsername('stefan')).toBe(true)
      expect(isValidUsername('Stefan')).toBe(true)
      expect(isValidUsername('admin123')).toBe(true)
      expect(isValidUsername('ABC')).toBe(true)
      expect(isValidUsername('user42')).toBe(true)
    })

    it('rejects usernames with spaces', () => {
      expect(isValidUsername('stefan müller')).toBe(false)
      expect(isValidUsername('john doe')).toBe(false)
    })

    it('rejects usernames with umlauts', () => {
      expect(isValidUsername('müller')).toBe(false)
      expect(isValidUsername('schön')).toBe(false)
      expect(isValidUsername('über')).toBe(false)
    })

    it('rejects usernames with special characters', () => {
      expect(isValidUsername('user@name')).toBe(false)
      expect(isValidUsername('user-name')).toBe(false)
      expect(isValidUsername('user_name')).toBe(false)
      expect(isValidUsername('user.name')).toBe(false)
      expect(isValidUsername('user!')).toBe(false)
    })

    it('rejects empty usernames', () => {
      expect(isValidUsername('')).toBe(false)
    })

    it('validateUsername throws for invalid usernames', () => {
      expect(() => validateUsername('stefan')).not.toThrow()
      expect(() => validateUsername('invalid user')).toThrow(/only alphanumeric/)
      expect(() => validateUsername('müller')).toThrow(/only alphanumeric/)
    })
  })

  it('enforces foreign key on sessions', () => {
    const db = initDatabase(tmpDbPath())

    // Insert user first
    db.prepare(
      'INSERT INTO users (username, password_hash) VALUES (?, ?)'
    ).run('testuser', 'hash')

    // Insert valid session
    db.prepare(
      "INSERT INTO sessions (id, user_id, source) VALUES (?, ?, ?)"
    ).run('session-1', 1, 'telegram')

    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get('session-1') as Record<string, unknown>
    expect(session.source).toBe('telegram')

    db.close()
  })
})
