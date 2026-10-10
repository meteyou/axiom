import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase } from '@axiom/core'
import type { Database } from '@axiom/core'
import { createApp } from '../app.js'
import { generateAccessToken } from '../auth.js'

let db: Database
let server: http.Server
let baseUrl: string
let tempDataDir: string
let previousDataDir: string | undefined
let adminToken: string
let aliceToken: string
let bobToken: string

function call(token: string, method: string, url: string, body?: unknown): Promise<Response> {
  return fetch(`${baseUrl}${url}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function createJob(token: string, name: string): Promise<{ id: string; ownerUserId: number }> {
  const res = await call(token, 'POST', '/api/cronjobs', { name, prompt: `${name} prompt`, schedule: '0 9 * * *' })
  expect(res.status).toBe(201)
  return ((await res.json()) as { cronjob: { id: string; ownerUserId: number } }).cronjob
}

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-cronjobs-scoping-'))
  process.env.DATA_DIR = tempDataDir

  db = initDatabase(':memory:')
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1, 'admin', 'h', 'admin'), (2, 'alice', 'h', 'user'), (3, 'bob', 'h', 'user')").run()
  server = http.createServer(createApp({ db }))
  await new Promise<void>(resolve => server.listen(0, resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const token = (userId: number, username: string, role: string) => generateAccessToken({ userId, username, role, tokenVersion: 0 })
  adminToken = token(1, 'admin', 'admin')
  aliceToken = token(2, 'alice', 'user')
  bobToken = token(3, 'bob', 'user')
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  db.close()
  fs.rmSync(tempDataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
})

describe('cronjobs API permission matrix', () => {
  it('assigns the creator as owner', async () => {
    const job = await createJob(aliceToken, 'Alice owner')
    expect(job.ownerUserId).toBe(2)
  })

  it('lists only own cronjobs for users and all (with owner filter) for admins', async () => {
    await createJob(aliceToken, 'Alice list')
    await createJob(bobToken, 'Bob list')

    const alice = await (await call(aliceToken, 'GET', '/api/cronjobs')).json() as { cronjobs: Array<{ name: string }> }
    expect(alice.cronjobs.map(j => j.name)).toContain('Alice list')
    expect(alice.cronjobs.map(j => j.name)).not.toContain('Bob list')

    const admin = await (await call(adminToken, 'GET', '/api/cronjobs')).json() as { cronjobs: Array<{ name: string; ownerUsername: string }> }
    expect(admin.cronjobs.map(j => j.name)).toEqual(expect.arrayContaining(['Alice list', 'Bob list']))
    expect(admin.cronjobs.find(j => j.name === 'Bob list')!.ownerUsername).toBe('bob')

    const filtered = await (await call(adminToken, 'GET', '/api/cronjobs?ownerUserId=3')).json() as { cronjobs: Array<{ name: string }> }
    expect(filtered.cronjobs.every(j => j.name.startsWith('Bob'))).toBe(true)
  })

  it('hides foreign cronjobs from regular users on update, delete and trigger', async () => {
    const bobJob = await createJob(bobToken, 'Bob hidden')
    expect((await call(aliceToken, 'PUT', `/api/cronjobs/${bobJob.id}`, { name: 'x' })).status).toBe(404)
    expect((await call(aliceToken, 'PUT', `/api/cronjobs/${bobJob.id}`, { enabled: false })).status).toBe(404)
    expect((await call(aliceToken, 'DELETE', `/api/cronjobs/${bobJob.id}`)).status).toBe(404)
    expect((await call(aliceToken, 'POST', `/api/cronjobs/${bobJob.id}/trigger`)).status).toBe(404)
    expect((await call(bobToken, 'PUT', `/api/cronjobs/${bobJob.id}`, { name: 'Bob renamed' })).status).toBe(200)
  })

  it('lets the admin only toggle and delete foreign cronjobs', async () => {
    const aliceJob = await createJob(aliceToken, 'Alice guarded')
    expect((await call(adminToken, 'PUT', `/api/cronjobs/${aliceJob.id}`, { name: 'hijack' })).status).toBe(403)
    expect((await call(adminToken, 'PUT', `/api/cronjobs/${aliceJob.id}`, { prompt: 'hijack', enabled: false })).status).toBe(403)
    expect((await call(adminToken, 'POST', `/api/cronjobs/${aliceJob.id}/trigger`)).status).toBe(403)

    const toggled = await call(adminToken, 'PUT', `/api/cronjobs/${aliceJob.id}`, { enabled: false })
    expect(toggled.status).toBe(200)
    expect(((await toggled.json()) as { cronjob: { enabled: boolean } }).cronjob.enabled).toBe(false)

    expect((await call(adminToken, 'DELETE', `/api/cronjobs/${aliceJob.id}`)).status).toBe(200)
    expect((await call(aliceToken, 'GET', '/api/cronjobs')).status).toBe(200)
  })

  it('lets owners delete their own cronjobs and attributes admin-created ones to the admin', async () => {
    const adminJob = await createJob(adminToken, 'Admin own')
    expect(adminJob.ownerUserId).toBe(1)
    expect((await call(adminToken, 'POST', `/api/cronjobs/${adminJob.id}/trigger`)).status).toBe(503)
    expect((await call(adminToken, 'DELETE', `/api/cronjobs/${adminJob.id}`)).status).toBe(200)
  })
})
