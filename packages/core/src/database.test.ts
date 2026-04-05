import { describe, it, expect, afterEach } from 'vitest'
import { initDatabase, isValidUsername, validateUsername } from './database.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

describe('database', () => {
  const tmpFiles: string[] = []

  afterEach(() => {
    for (const f of tmpFiles) {
      try { fs.unlinkSync(f) } catch { /* ignore */ }
    }
    tmpFiles.length = 0
  })

  function tmpDbPath(): string {
    const p = path.join(os.tmpdir(), `openagent-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
    tmpFiles.push(p)
    return p
  }

  it('creates database with all tables', () => {
    const db = initDatabase(tmpDbPath())

    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as { name: string }[]

    const tableNames = tables.map(t => t.name)
    expect(tableNames).toContain('token_usage')
    expect(tableNames).toContain('tool_calls')
    expect(tableNames).toContain('users')
    expect(tableNames).toContain('sessions')
    expect(tableNames).toContain('health_checks')

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
