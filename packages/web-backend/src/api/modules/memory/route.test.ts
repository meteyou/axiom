import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AgentCore, Database } from '@axiom/core'
import { createMemory, initDatabase } from '@axiom/core'
import { createApp } from '../../../app.js'
import { generateAccessToken } from '../../../auth.js'

let db: Database
let server: http.Server
let baseUrl: string
let adminToken: string
let userToken: string
let tempDataDir: string
let previousDataDir: string | undefined
const refreshSystemPrompt = vi.fn()

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-memory-route-'))
  process.env.DATA_DIR = tempDataDir

  db = initDatabase(':memory:')

  const getAgentCore = () => ({
    refreshSystemPrompt,
  }) as unknown as AgentCore

  server = http.createServer(createApp({ db, getAgentCore }))
  await new Promise<void>((resolve) => server.listen(0, resolve))

  const port = (server.address() as { port: number }).port
  baseUrl = `http://127.0.0.1:${port}`

  adminToken = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })
  userToken = generateAccessToken({ userId: 2, username: 'user', role: 'user' })
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))

  if (previousDataDir === undefined) {
    delete process.env.DATA_DIR
  } else {
    process.env.DATA_DIR = previousDataDir
  }

  fs.rmSync(tempDataDir, { recursive: true, force: true })
})

beforeEach(() => {
  refreshSystemPrompt.mockClear()
  db.prepare('DELETE FROM memories').run()
  db.prepare('DELETE FROM users WHERE id != 1').run()
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (2, 'user', 'x', 'user')").run()
})

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` }
}

describe('memory route module', () => {
  it('keeps core memory workflows stable for soul and daily files', async () => {
    const getSoulRes = await fetch(`${baseUrl}/api/memory/soul`, {
      headers: authHeaders(adminToken),
    })

    const getSoulBody = await getSoulRes.json() as { content: string }

    expect(getSoulRes.status).toBe(200)
    expect(getSoulBody.content).toContain('# Soul')

    const putSoulRes = await fetch(`${baseUrl}/api/memory/soul`, {
      method: 'PUT',
      headers: {
        ...authHeaders(adminToken),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: '# Soul\n\nUpdated\n' }),
    })

    expect(putSoulRes.status).toBe(200)
    expect(refreshSystemPrompt).toHaveBeenCalledTimes(1)

    const putDailyRes = await fetch(`${baseUrl}/api/memory/daily/2026-03-27`, {
      method: 'PUT',
      headers: {
        ...authHeaders(adminToken),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: '# Daily\n\nNote\n' }),
    })

    expect(putDailyRes.status).toBe(200)

    const listDailyRes = await fetch(`${baseUrl}/api/memory/daily`, {
      headers: authHeaders(adminToken),
    })

    const listDailyBody = await listDailyRes.json() as {
      files: Array<{ date: string; filename: string }>
    }

    expect(listDailyRes.status).toBe(200)
    expect(listDailyBody.files.some(file => file.date === '2026-03-27')).toBe(true)

    const getDailyRes = await fetch(`${baseUrl}/api/memory/daily/2026-03-27`, {
      headers: authHeaders(adminToken),
    })

    const getDailyBody = await getDailyRes.json() as { content: string }

    expect(getDailyRes.status).toBe(200)
    expect(getDailyBody.content).toContain('Note')
  })

  it('returns boundary validation errors for invalid memory inputs', async () => {
    const invalidDailyRes = await fetch(`${baseUrl}/api/memory/daily/not-a-date`, {
      headers: authHeaders(adminToken),
    })

    expect(invalidDailyRes.status).toBe(400)

    const invalidFactQueryRes = await fetch(`${baseUrl}/api/memory/facts?limit=nope`, {
      headers: authHeaders(adminToken),
    })

    expect(invalidFactQueryRes.status).toBe(400)

    const invalidFactIdRes = await fetch(`${baseUrl}/api/memory/facts/not-a-number`, {
      method: 'PUT',
      headers: {
        ...authHeaders(adminToken),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: 'Updated content' }),
    })

    expect(invalidFactIdRes.status).toBe(400)

    const missingWikiRes = await fetch(`${baseUrl}/api/memory/wiki/nonexistent-page`, {
      headers: authHeaders(adminToken),
    })

    expect(missingWikiRes.status).toBe(404)
  })

  it('supports listing, updating, and deleting extracted facts', async () => {
    db.prepare('INSERT OR IGNORE INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)')
      .run(2, 'regular-user', 'hash', 'user')

    const dockerFactId = createMemory(db, 1, 'session-a', 'User works with Docker every day', 'session')
    createMemory(db, 1, 'session-b', 'Prefers Postgres', 'session')
    const secondUserFactId = createMemory(db, 2, 'session-c', 'Enjoys gardening', 'session')

    const queryRes = await fetch(`${baseUrl}/api/memory/facts?query=docker`, {
      headers: authHeaders(adminToken),
    })

    const queryBody = await queryRes.json() as {
      facts: Array<{ id: number; content: string }>
      total: number
    }

    expect(queryRes.status).toBe(200)
    expect(queryBody.total).toBe(1)
    expect(queryBody.facts[0]?.id).toBe(dockerFactId)

    const updateRes = await fetch(`${baseUrl}/api/memory/facts/${dockerFactId}`, {
      method: 'PUT',
      headers: {
        ...authHeaders(adminToken),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: 'User works with Docker and Kubernetes every day' }),
    })

    expect(updateRes.status).toBe(200)

    const updatedFact = db.prepare('SELECT content FROM memories WHERE id = ?').get(dockerFactId) as { content: string }
    expect(updatedFact.content).toContain('Kubernetes')

    const deleteRes = await fetch(`${baseUrl}/api/memory/facts/${secondUserFactId}`, {
      method: 'DELETE',
      headers: authHeaders(adminToken),
    })

    expect(deleteRes.status).toBe(200)

    const deletedFact = db.prepare('SELECT id FROM memories WHERE id = ?').get(secondUserFactId)
    expect(deletedFact).toBeUndefined()
  })

  it('enforces authentication and admin access boundaries', async () => {
    const unauthenticatedRes = await fetch(`${baseUrl}/api/memory/soul`)
    expect(unauthenticatedRes.status).toBe(401)

    const nonAdminRes = await fetch(`${baseUrl}/api/memory/soul`, {
      headers: authHeaders(userToken),
    })
    expect(nonAdminRes.status).toBe(403)
  })

  describe('regular users', () => {
    const json = (token: string) => ({ ...authHeaders(token), 'Content-Type': 'application/json' })

    it('reads and writes only their own profile and daily notes', async () => {
      const put = await fetch(`${baseUrl}/api/memory/profile`, {
        method: 'PUT', headers: json(userToken), body: JSON.stringify({ content: 'user profile' }),
      })
      expect(put.status).toBe(200)
      expect(fs.readFileSync(path.join(tempDataDir, 'users', 'user', 'PROFILE.md'), 'utf-8')).toBe('user profile')

      const adminProfile = await (await fetch(`${baseUrl}/api/memory/profile`, { headers: authHeaders(adminToken) })).json() as { content: string }
      expect(adminProfile.content).not.toContain('user profile')

      await fetch(`${baseUrl}/api/memory/daily/2026-04-01`, {
        method: 'PUT', headers: json(userToken), body: JSON.stringify({ content: 'private note' }),
      })
      const userList = await (await fetch(`${baseUrl}/api/memory/daily`, { headers: authHeaders(userToken) })).json() as { files: Array<{ date: string }> }
      expect(userList.files.map(f => f.date)).toEqual(['2026-04-01'])
      const adminGet = await fetch(`${baseUrl}/api/memory/daily/2026-04-01`, { headers: authHeaders(adminToken) })
      expect(adminGet.status).toBe(404)
    })

    it('lists, updates and deletes only their own facts', async () => {
      const adminFact = createMemory(db, 1, 's1', 'admin fact', 'session')
      const ownFact = createMemory(db, 2, 's2', 'own fact', 'session')

      const list = await (await fetch(`${baseUrl}/api/memory/facts?userId=1`, { headers: authHeaders(userToken) })).json() as { facts: Array<{ id: number }> }
      expect(list.facts.map(f => f.id)).toEqual([ownFact])

      const foreignPut = await fetch(`${baseUrl}/api/memory/facts/${adminFact}`, {
        method: 'PUT', headers: json(userToken), body: JSON.stringify({ content: 'hacked' }),
      })
      expect(foreignPut.status).toBe(404)
      const foreignDelete = await fetch(`${baseUrl}/api/memory/facts/${adminFact}`, { method: 'DELETE', headers: authHeaders(userToken) })
      expect(foreignDelete.status).toBe(404)

      const ownPut = await fetch(`${baseUrl}/api/memory/facts/${ownFact}`, {
        method: 'PUT', headers: json(userToken), body: JSON.stringify({ content: 'edited' }),
      })
      expect(ownPut.status).toBe(200)
      const ownDelete = await fetch(`${baseUrl}/api/memory/facts/${ownFact}`, { method: 'DELETE', headers: authHeaders(userToken) })
      expect(ownDelete.status).toBe(200)
    })

    it('reads and writes wiki pages', async () => {
      const put = await fetch(`${baseUrl}/api/memory/wiki/shared-page`, {
        method: 'PUT', headers: json(userToken), body: JSON.stringify({ content: '# Shared' }),
      })
      expect(put.status).toBe(200)
      const get = await fetch(`${baseUrl}/api/memory/wiki/shared-page`, { headers: authHeaders(userToken) })
      expect(get.status).toBe(200)
      const list = await fetch(`${baseUrl}/api/memory/wiki`, { headers: authHeaders(userToken) })
      expect(list.status).toBe(200)
      const del = await fetch(`${baseUrl}/api/memory/wiki/shared-page`, { method: 'DELETE', headers: authHeaders(userToken) })
      expect(del.status).toBe(200)
    })

    it('rejects admin-only endpoints with 403', async () => {
      for (const p of ['soul', 'core', 'agents', 'files', 'file?path=SOUL.md', 'consolidation-rules', 'tasks-guidelines', 'consolidation/status', 'usage-stats', 'heartbeat', 'projects']) {
        const res = await fetch(`${baseUrl}/api/memory/${p}`, { headers: authHeaders(userToken) })
        expect(res.status, p).toBe(403)
      }
      const run = await fetch(`${baseUrl}/api/memory/consolidation/run`, { method: 'POST', headers: authHeaders(userToken) })
      expect(run.status).toBe(403)
    })
  })
})
