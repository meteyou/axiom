import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import bcrypt from 'bcrypt'
import { WebSocket } from 'ws'
import { initDatabase } from '@axiom/core'
import type { Database } from '@axiom/core'
import { createApp } from '../app.js'
import { setupWebSocketChat } from '../ws-chat.js'
import { setupWebSocketLogs } from '../ws-logs.js'

let db: Database
let server: http.Server
let baseUrl: string
let wsUrl: string
let tempDataDir: string
let previousDataDir: string | undefined

interface Tokens { accessToken: string; refreshToken: string }

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-users-auth-'))
  process.env.DATA_DIR = tempDataDir
  process.env.ADMIN_PASSWORD = 'adminpw'

  db = initDatabase(':memory:')
  server = http.createServer(createApp({ db }))
  setupWebSocketChat(server, db, null)
  setupWebSocketLogs(server, db)
  await new Promise<void>(resolve => server.listen(0, resolve))
  const port = (server.address() as { port: number }).port
  baseUrl = `http://127.0.0.1:${port}`
  wsUrl = `ws://127.0.0.1:${port}`
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
  delete process.env.ADMIN_PASSWORD
  fs.rmSync(tempDataDir, { recursive: true, force: true })
})

async function login(username: string, password: string): Promise<Tokens> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  expect(res.status).toBe(200)
  return await res.json() as Tokens
}

function call(token: string, method: string, url: string, body?: unknown): Promise<Response> {
  return fetch(`${baseUrl}${url}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function createUser(adminToken: string, username: string, password = 'secret1', role = 'user'): Promise<number> {
  const res = await call(adminToken, 'POST', '/api/users', { username, password, role })
  expect(res.status).toBe(201)
  return ((await res.json()) as { user: { id: number } }).user.id
}

function adminLogin(): Promise<Tokens> {
  return login('admin', 'adminpw')
}

function openSocket(pathAndQuery: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsUrl}${pathAndQuery}`)
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
    ws.once('unexpected-response', (_req, res) => reject(new Error(`status ${res.statusCode}`)))
  })
}

function closed(ws: WebSocket): Promise<number> {
  return new Promise(resolve => ws.once('close', code => resolve(code)))
}

describe('token versioning', () => {
  it('rejects old access and refresh tokens after an admin password reset', async () => {
    const admin = await adminLogin()
    const id = await createUser(admin.accessToken, 'resetme', 'secret1', 'admin')
    const old = await login('resetme', 'secret1')
    expect((await call(old.accessToken, 'GET', '/api/auth/me')).status).toBe(200)
    const logs = await openSocket(`/ws/logs?token=${old.accessToken}`)
    const logsClosed = closed(logs)

    const reset = await call(admin.accessToken, 'PUT', `/api/users/${id}`, { password: 'newpass1' })
    expect(reset.status).toBe(200)
    expect(await logsClosed).toBe(4401)

    expect((await call(old.accessToken, 'GET', '/api/auth/me')).status).toBe(401)
    const refresh = await fetch(`${baseUrl}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: old.refreshToken }),
    })
    expect(refresh.status).toBe(401)
    await expect(openSocket(`/ws/logs?token=${old.accessToken}`)).rejects.toThrow()

    const fresh = await login('resetme', 'newpass1')
    expect((await call(fresh.accessToken, 'GET', '/api/auth/me')).status).toBe(200)
  })

  it('closes open sockets and applies role changes without re-login', async () => {
    const admin = await adminLogin()
    const id = await createUser(admin.accessToken, 'promoted')
    const tokens = await login('promoted', 'secret1')

    expect((await call(tokens.accessToken, 'GET', '/api/health')).status).toBeGreaterThanOrEqual(200)
    await expect(openSocket(`/ws/logs?token=${tokens.accessToken}`)).rejects.toThrow()

    const chat = await openSocket(`/ws/chat?token=${tokens.accessToken}`)
    const chatClosed = closed(chat)

    const res = await call(admin.accessToken, 'PUT', `/api/users/${id}`, { role: 'admin' })
    expect(res.status).toBe(200)
    expect(await chatClosed).toBe(4401)

    expect((await call(tokens.accessToken, 'GET', '/api/users')).status).toBe(401)
    await expect(openSocket(`/ws/logs?token=${tokens.accessToken}`)).rejects.toThrow()
    const fresh = await login('promoted', 'secret1')
    const freshLogs = await openSocket(`/ws/logs?token=${fresh.accessToken}`)
    freshLogs.close()
    const list = await call(fresh.accessToken, 'GET', '/api/users')
    expect(((await list.json()) as { users: unknown[] }).users.length).toBeGreaterThan(1)
  })

  it('reads the role from the database, not from the token', async () => {
    const admin = await adminLogin()
    const id = await createUser(admin.accessToken, 'dbrole')
    const tokens = await login('dbrole', 'secret1')
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(id)
    const res = await call(tokens.accessToken, 'GET', '/api/users')
    expect(((await res.json()) as { users: unknown[] }).users.length).toBeGreaterThan(1)
  })

  it('rejects tokens of deleted users', async () => {
    const admin = await adminLogin()
    const id = await createUser(admin.accessToken, 'gone')
    const tokens = await login('gone', 'secret1')
    db.prepare('DELETE FROM users WHERE id = ?').run(id)
    expect((await call(tokens.accessToken, 'GET', '/api/users')).status).toBe(401)
  })

  it('closes open sockets of a user deleted via the API', async () => {
    const admin = await adminLogin()
    const id = await createUser(admin.accessToken, 'deleteme')
    const tokens = await login('deleteme', 'secret1')
    const chat = await openSocket(`/ws/chat?token=${tokens.accessToken}`)
    const chatClosed = closed(chat)

    expect((await call(admin.accessToken, 'DELETE', `/api/users/${id}`)).status).toBe(200)
    expect(await chatClosed).toBe(4401)
  })
})

describe('own account', () => {
  it('lists only the caller for regular users and forbids management', async () => {
    const admin = await adminLogin()
    await createUser(admin.accessToken, 'solo')
    const tokens = await login('solo', 'secret1')

    const list = await call(tokens.accessToken, 'GET', '/api/users')
    const users = ((await list.json()) as { users: { username: string }[] }).users
    expect(users.map(u => u.username)).toEqual(['solo'])

    const me = users[0] as unknown as { id: number }
    expect((await call(tokens.accessToken, 'PUT', `/api/users/${me.id}`, { role: 'admin' })).status).toBe(403)
    expect((await call(tokens.accessToken, 'POST', '/api/users', { username: 'x1', password: 'abcd' })).status).toBe(403)
    expect((await call(tokens.accessToken, 'DELETE', `/api/users/${me.id}`)).status).toBe(403)
  })

  it('requires the current password to change the own password and invalidates other logins', async () => {
    const admin = await adminLogin()
    await createUser(admin.accessToken, 'changer')
    const sessionA = await login('changer', 'secret1')
    const sessionB = await login('changer', 'secret1')

    const wrong = await call(sessionA.accessToken, 'PUT', '/api/users/me/password', {
      currentPassword: 'nope', newPassword: 'brandnew1',
    })
    expect(wrong.status).toBe(403)
    expect((await call(sessionB.accessToken, 'GET', '/api/auth/me')).status).toBe(200)

    const ok = await call(sessionA.accessToken, 'PUT', '/api/users/me/password', {
      currentPassword: 'secret1', newPassword: 'brandnew1',
    })
    expect(ok.status).toBe(200)
    const renewed = await ok.json() as Tokens

    expect((await call(sessionA.accessToken, 'GET', '/api/auth/me')).status).toBe(401)
    expect((await call(sessionB.accessToken, 'GET', '/api/auth/me')).status).toBe(401)
    expect((await call(renewed.accessToken, 'GET', '/api/auth/me')).status).toBe(200)

    const row = db.prepare('SELECT password_hash FROM users WHERE username = ?').get('changer') as { password_hash: string }
    expect(bcrypt.compareSync('brandnew1', row.password_hash)).toBe(true)
  })
})

describe('bootstrap admin', () => {
  it('cannot be demoted', async () => {
    const admin = await adminLogin()
    const bootstrapId = (db.prepare('SELECT MIN(id) AS id FROM users').get() as { id: number }).id
    const res = await call(admin.accessToken, 'PUT', `/api/users/${bootstrapId}`, { role: 'user' })
    expect(res.status).toBe(400)
    const row = db.prepare('SELECT role FROM users WHERE id = ?').get(bootstrapId) as { role: string }
    expect(row.role).toBe('admin')
    expect((await call(admin.accessToken, 'GET', '/api/auth/me')).status).toBe(200)
  })

  it('cannot be displaced by promoting an older account', async () => {
    const admin = await adminLogin()
    const bootstrapId = (db.prepare("SELECT MIN(id) AS id FROM users WHERE role = 'admin'").get() as { id: number }).id
    db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (0, 'legacyfirst', 'h', 'user')").run()
    try {
      const res = await call(admin.accessToken, 'PUT', '/api/users/0', { role: 'admin' })
      expect(res.status).toBe(400)
      expect((db.prepare('SELECT role FROM users WHERE id = 0').get() as { role: string }).role).toBe('user')
      expect((db.prepare("SELECT MIN(id) AS id FROM users WHERE role = 'admin'").get() as { id: number }).id).toBe(bootstrapId)
    } finally {
      db.prepare('DELETE FROM users WHERE id = 0').run()
    }
  })
})

describe('soft delete', () => {
  it('cascades, keeps sessions and usage, and reserves the username', async () => {
    const admin = await adminLogin()
    const id = await createUser(admin.accessToken, 'victim')
    const tokens = await login('victim', 'secret1')
    const personalDir = path.join(tempDataDir, 'users', 'victim')
    expect(fs.existsSync(personalDir)).toBe(true)

    db.prepare("INSERT INTO sessions (id, user_id, source) VALUES ('s-victim', ?, 'web')").run(id)
    db.prepare("INSERT INTO chat_messages (session_id, user_id, role, content) VALUES ('s-victim', ?, 'user', 'hi')").run(id)
    db.prepare("INSERT INTO tool_calls (session_id, tool_name) VALUES ('s-victim', 'shell')").run()
    db.prepare("INSERT INTO memories (user_id, session_id, content, source) VALUES (?, 's-victim', 'fact', 'chat')").run(id)
    db.prepare("INSERT INTO token_usage (session_id, provider, model, prompt_tokens, completion_tokens) VALUES ('s-victim', 'p', 'm', 5, 5)").run()
    db.prepare("INSERT INTO tasks (id, name, prompt, status, trigger_type, owner_user_id) VALUES ('t-victim', 'n', 'p', 'running', 'user', ?)").run(id)
    db.prepare("INSERT INTO scheduled_tasks (id, name, prompt, schedule, action_type, enabled, owner_user_id) VALUES ('c-victim', 'n', 'p', '* * * * *', 'task', 1, ?)").run(id)
    db.prepare("UPDATE users SET telegram_id = '123' WHERE id = ?").run(id)

    const res = await call(admin.accessToken, 'DELETE', `/api/users/${id}`)
    expect(res.status).toBe(200)

    const count = (sql: string) => (db.prepare(sql).get(id) as { n: number }).n
    expect(count('SELECT COUNT(*) AS n FROM chat_messages WHERE user_id = ?')).toBe(0)
    expect((db.prepare("SELECT COUNT(*) AS n FROM tool_calls WHERE session_id = 's-victim'").get() as { n: number }).n).toBe(0)
    expect(count('SELECT COUNT(*) AS n FROM memories WHERE user_id = ?')).toBe(0)
    expect(count('SELECT COUNT(*) AS n FROM tasks WHERE owner_user_id = ?')).toBe(0)
    expect(count('SELECT COUNT(*) AS n FROM scheduled_tasks WHERE owner_user_id = ?')).toBe(0)
    expect(count('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?')).toBe(1)
    expect((db.prepare("SELECT COUNT(*) AS n FROM token_usage WHERE session_id = 's-victim'").get() as { n: number }).n).toBe(1)
    const row = db.prepare('SELECT deleted_at, telegram_id FROM users WHERE id = ?').get(id) as { deleted_at: string | null; telegram_id: string | null }
    expect(row.deleted_at).not.toBeNull()
    expect(row.telegram_id).toBeNull()
    expect(fs.existsSync(personalDir)).toBe(false)

    expect((await call(tokens.accessToken, 'GET', '/api/users')).status).toBe(401)
    const relogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'victim', password: 'secret1' }),
    })
    expect(relogin.status).toBe(401)

    // A repeated DELETE resumes the idempotent cascade instead of 404ing.
    db.prepare("INSERT INTO memories (user_id, session_id, content, source) VALUES (?, 's-victim', 'late', 'chat')").run(id)
    expect((await call(admin.accessToken, 'DELETE', `/api/users/${id}`)).status).toBe(200)
    expect(count('SELECT COUNT(*) AS n FROM memories WHERE user_id = ?')).toBe(0)

    const listed = await call(admin.accessToken, 'GET', '/api/users')
    expect(((await listed.json()) as { users: { username: string }[] }).users.map(u => u.username)).not.toContain('victim')
    const reuse = await call(admin.accessToken, 'POST', '/api/users', { username: 'victim', password: 'secret1' })
    expect(reuse.status).toBe(409)
  })

  it('keeps files when deleteFiles=false', async () => {
    const admin = await adminLogin()
    const id = await createUser(admin.accessToken, 'keeper')
    const personalDir = path.join(tempDataDir, 'users', 'keeper')
    expect((await call(admin.accessToken, 'DELETE', `/api/users/${id}?deleteFiles=false`)).status).toBe(200)
    expect(fs.existsSync(personalDir)).toBe(true)
  })

  it('rejects deleting yourself and the bootstrap admin', async () => {
    const admin = await adminLogin()
    const bootstrapId = (db.prepare('SELECT MIN(id) AS id FROM users').get() as { id: number }).id
    expect((await call(admin.accessToken, 'DELETE', `/api/users/${bootstrapId}`)).status).toBe(400)
    const otherId = await createUser(admin.accessToken, 'otheradmin', 'secret1', 'admin')
    const other = await login('otheradmin', 'secret1')
    expect((await call(other.accessToken, 'DELETE', `/api/users/${otherId}`)).status).toBe(400)
  })
})
