import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase, createBaseAgentTools, resolveUserScope } from '@axiom/core'
import type { Database } from '@axiom/core'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { createApp } from '../app.js'

let db: Database
let server: http.Server
let baseUrl: string
let tempDir: string
const previous: Record<string, string | undefined> = {}

async function login(username: string, password: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  return ((await res.json()) as { accessToken: string }).accessToken
}

function call(token: string, method: string, url: string, body?: unknown): Promise<Response> {
  return fetch(`${baseUrl}${url}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function createUser(adminToken: string, username: string, role = 'user'): Promise<number> {
  const res = await call(adminToken, 'POST', '/api/users', { username, password: 'secret1', role })
  expect(res.status).toBe(201)
  return ((await res.json()) as { user: { id: number } }).user.id
}

function shellOf(userId: number): AgentTool {
  const scope = resolveUserScope(db, userId)!
  const tool = createBaseAgentTools({ db, user: scope }).find(t => t.name === 'shell')!
  return tool
}

async function runEcho(userId: number): Promise<string> {
  const result = await shellOf(userId).execute('c', { command: 'echo "[$SHARED_VAR][$ONLY_B]"' })
  return (result.content[0] as { text: string }).text.trim()
}

beforeAll(async () => {
  for (const key of ['DATA_DIR', 'WORKSPACE_DIR', 'ADMIN_PASSWORD', 'ENCRYPTION_KEY']) previous[key] = process.env[key]
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-secrets-'))
  process.env.DATA_DIR = tempDir
  process.env.WORKSPACE_DIR = path.join(tempDir, 'workspace')
  process.env.ADMIN_PASSWORD = 'adminpw'
  process.env.ENCRYPTION_KEY ??= 'test-encryption-key-test-encryption-key'
  db = initDatabase(':memory:')
  server = http.createServer(createApp({ db }))
  await new Promise<void>(resolve => server.listen(0, resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  delete process.env.SHARED_VAR
  delete process.env.ONLY_B
  fs.rmSync(tempDir, { recursive: true, force: true })
})

describe('per-user secrets', () => {
  it('scopes secrets per user, encrypts them and never touches process.env', async () => {
    const admin = await login('admin', 'adminpw')
    const aId = await createUser(admin, 'usera')
    const bId = await createUser(admin, 'userb')
    const a = await login('usera', 'secret1')
    const b = await login('userb', 'secret1')

    expect((await call(admin, 'PUT', '/api/secrets', { secrets: { SHARED_VAR: 'global' } })).status).toBe(200)
    const put = await call(b, 'PUT', '/api/secrets', { secrets: { SHARED_VAR: 'bvalue-secret', ONLY_B: 'b-only-token' } })
    expect(put.status).toBe(200)
    const putBody = await put.json() as { secrets: Array<{ key: string }> }
    expect(putBody.secrets.map(s => s.key).sort()).toEqual(['ONLY_B', 'SHARED_VAR'])
    expect(JSON.stringify(putBody)).not.toContain('b-only-token')

    const file = path.join(tempDir, 'users', 'userb', 'secrets.json')
    const raw = fs.readFileSync(file, 'utf-8')
    expect(raw).not.toContain('b-only-token')
    expect(raw).not.toContain('bvalue-secret')

    const aList = await (await call(a, 'GET', '/api/secrets')).json() as { scope: string; secrets: unknown[] }
    expect(aList.scope).toBe('personal')
    expect(aList.secrets).toEqual([])
    const adminList = await (await call(admin, 'GET', '/api/secrets')).json() as { scope: string; secrets: Array<{ key: string }> }
    expect(adminList.scope).toBe('global')
    expect(adminList.secrets.map(s => s.key)).toEqual(['SHARED_VAR'])

    expect(await runEcho(bId)).toBe('[bvalue-secret][b-only-token]')
    expect(await runEcho(aId)).toBe('[global][]')
    expect(process.env.ONLY_B).toBeUndefined()
    expect(process.env.SHARED_VAR).toBe('global')

    expect((await call(b, 'DELETE', '/api/secrets/ONLY_B')).status).toBe(200)
    expect(await runEcho(bId)).toBe('[bvalue-secret][]')
  })

  it('gives non-bootstrap admins their own secrets plus a read-only view of the global ones', async () => {
    const admin = await login('admin', 'adminpw')
    await createUser(admin, 'secondadmin', 'admin')
    const second = await login('secondadmin', 'secret1')
    await call(second, 'PUT', '/api/secrets', { secrets: { SECOND_TOKEN: 'x' } })
    const list = await (await call(second, 'GET', '/api/secrets')).json() as {
      scope: string
      secrets: Array<{ key: string }>
      globalSecrets: Array<{ key: string }>
    }
    expect(list.scope).toBe('personal')
    expect(list.secrets.map(s => s.key)).toEqual(['SECOND_TOKEN'])
    expect(list.globalSecrets.map(s => s.key)).toEqual(['SHARED_VAR'])
    const bootstrap = await (await call(admin, 'GET', '/api/secrets')).json() as { secrets: Array<{ key: string }> }
    expect(bootstrap.secrets.map(s => s.key)).not.toContain('SECOND_TOKEN')
  })
})
