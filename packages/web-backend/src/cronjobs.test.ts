import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createApp } from './app.js'
import { initDatabase } from '@openagent/core'
import type { Database } from '@openagent/core'
import { generateAccessToken } from './auth.js'

let db: Database
let server: http.Server
let port: number
let baseUrl: string
let token: string
let tempDataDir: string
let previousDataDir: string | undefined

async function apiFetch(urlPath: string, options: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
    ...(options.headers as Record<string, string> || {}),
  }
  return fetch(`${baseUrl}${urlPath}`, { ...options, headers })
}

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openagent-cronjobs-test-'))
  process.env.DATA_DIR = tempDataDir

  db = initDatabase(':memory:')
  const app = createApp({ db })
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const addr = server.address() as { port: number }
  port = addr.port
  baseUrl = `http://localhost:${port}`
  token = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()))
  })
  db.close()
  fs.rmSync(tempDataDir, { recursive: true, force: true })
  if (previousDataDir !== undefined) {
    process.env.DATA_DIR = previousDataDir
  } else {
    delete process.env.DATA_DIR
  }
})

describe('Cronjobs REST API', () => {
  let createdId: string

  describe('POST /api/cronjobs', () => {
    it('creates a new cronjob', async () => {
      const res = await apiFetch('/api/cronjobs', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Daily Summary',
          prompt: 'Summarize the news',
          schedule: '0 9 * * *',
        }),
      })

      expect(res.status).toBe(201)
      const body = await res.json() as { cronjob: { id: string; name: string; schedule: string; scheduleHuman: string; enabled: boolean } }
      expect(body.cronjob.id).toBeTruthy()
      expect(body.cronjob.name).toBe('Daily Summary')
      expect(body.cronjob.schedule).toBe('0 9 * * *')
      expect(body.cronjob.scheduleHuman).toBeTruthy()
      expect(body.cronjob.enabled).toBe(true)
      createdId = body.cronjob.id
    })

    it('validates cron expression', async () => {
      const res = await apiFetch('/api/cronjobs', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Bad Cron',
          prompt: 'test',
          schedule: 'invalid',
        }),
      })

      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(body.error).toContain('Invalid cron expression')
    })

    it('requires name, prompt, schedule', async () => {
      const res = await apiFetch('/api/cronjobs', {
        method: 'POST',
        body: JSON.stringify({ name: 'Only name' }),
      })

      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(body.error).toContain('Missing required fields')
    })
  })

  describe('GET /api/cronjobs', () => {
    it('returns all cronjobs', async () => {
      const res = await apiFetch('/api/cronjobs')
      expect(res.status).toBe(200)
      const body = await res.json() as { cronjobs: { id: string }[] }
      expect(body.cronjobs.length).toBeGreaterThanOrEqual(1)
      expect(body.cronjobs[0]).toHaveProperty('scheduleHuman')
    })
  })

  describe('PUT /api/cronjobs/:id', () => {
    it('updates a cronjob', async () => {
      const res = await apiFetch(`/api/cronjobs/${createdId}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: 'Updated Summary',
          schedule: '0 10 * * *',
        }),
      })

      expect(res.status).toBe(200)
      const body = await res.json() as { cronjob: { name: string; schedule: string } }
      expect(body.cronjob.name).toBe('Updated Summary')
      expect(body.cronjob.schedule).toBe('0 10 * * *')
    })

    it('validates cron expression on update', async () => {
      const res = await apiFetch(`/api/cronjobs/${createdId}`, {
        method: 'PUT',
        body: JSON.stringify({ schedule: 'bad' }),
      })

      expect(res.status).toBe(400)
    })

    it('returns 404 for non-existent id', async () => {
      const res = await apiFetch('/api/cronjobs/non-existent', {
        method: 'PUT',
        body: JSON.stringify({ name: 'New Name' }),
      })

      expect(res.status).toBe(404)
    })

    it('toggles enabled status', async () => {
      const res = await apiFetch(`/api/cronjobs/${createdId}`, {
        method: 'PUT',
        body: JSON.stringify({ enabled: false }),
      })

      expect(res.status).toBe(200)
      const body = await res.json() as { cronjob: { enabled: boolean } }
      expect(body.cronjob.enabled).toBe(false)
    })
  })

  describe('POST /api/cronjobs/:id/trigger', () => {
    it('returns 503 when no scheduler is available', async () => {
      const res = await apiFetch(`/api/cronjobs/${createdId}/trigger`, {
        method: 'POST',
      })

      // No task scheduler configured in test app
      expect(res.status).toBe(503)
    })

    it('returns 404 for non-existent cronjob', async () => {
      const res = await apiFetch('/api/cronjobs/non-existent/trigger', {
        method: 'POST',
      })

      expect(res.status).toBe(404)
    })
  })

  describe('DELETE /api/cronjobs/:id', () => {
    it('deletes a cronjob', async () => {
      const res = await apiFetch(`/api/cronjobs/${createdId}`, {
        method: 'DELETE',
      })

      expect(res.status).toBe(200)
      const body = await res.json() as { success: boolean }
      expect(body.success).toBe(true)

      // Verify it's gone
      const getRes = await apiFetch(`/api/cronjobs/${createdId}`, {
        method: 'PUT',
        body: JSON.stringify({ name: 'Should Fail' }),
      })
      expect(getRes.status).toBe(404)
    })

    it('returns 404 for non-existent id', async () => {
      const res = await apiFetch('/api/cronjobs/non-existent', {
        method: 'DELETE',
      })

      expect(res.status).toBe(404)
    })
  })

  describe('JWT protection', () => {
    it('rejects requests without auth', async () => {
      const res = await fetch(`${baseUrl}/api/cronjobs`)
      expect(res.status).toBe(401)
    })
  })
})
