import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { Database } from '@axiom/core'
import { initDatabase } from '@axiom/core'
import { createApp } from '../../../app.js'
import { generateAccessToken } from '../../../auth.js'

let db: Database
let server: http.Server
let baseUrl: string
let adminToken: string
let bobToken: string
let carolToken: string
let tempDataDir: string
let previousDataDir: string | undefined

function writeConfig(name: string, content: unknown): void {
  fs.mkdirSync(path.join(tempDataDir, 'config'), { recursive: true })
  fs.writeFileSync(path.join(tempDataDir, 'config', name), JSON.stringify(content), 'utf-8')
}

function headers(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
}

async function put(token: string, url: string, body: unknown) {
  return fetch(`${baseUrl}${url}`, { method: 'PUT', headers: headers(token), body: JSON.stringify(body) })
}

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-own-settings-'))
  process.env.DATA_DIR = tempDataDir
  writeConfig('settings.json', { thinkingLevel: 'low', language: 'German' })
  writeConfig('providers.json', {
    activeProvider: 'p1',
    activeModel: 'm1',
    providers: [
      { id: 'p1', name: 'One', providerType: 'openai', apiKey: 'secret-key', enabledModels: ['m1'] },
      { id: 'p2', name: 'Two', providerType: 'anthropic', apiKey: 'secret-key', enabledModels: ['m2'] },
    ],
  })

  db = initDatabase(':memory:')
  server = http.createServer(createApp({ db }))
  await new Promise<void>((resolve) => server.listen(0, resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`

  const admin = Number(db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('boss', 'h', 'admin')").run().lastInsertRowid)
  const bob = Number(db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('bob', 'h', 'user')").run().lastInsertRowid)
  const carol = Number(db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('carol', 'h', 'user')").run().lastInsertRowid)
  adminToken = generateAccessToken({ userId: admin, username: 'boss', role: 'admin' })
  bobToken = generateAccessToken({ userId: bob, username: 'bob', role: 'user' })
  carolToken = generateAccessToken({ userId: carol, username: 'carol', role: 'user' })
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
  fs.rmSync(tempDataDir, { recursive: true, force: true })
})

describe('own settings endpoints', () => {
  it('keeps global settings admin-only', async () => {
    expect((await fetch(`${baseUrl}/api/settings`, { headers: headers(bobToken) })).status).toBe(403)
    expect((await put(bobToken, '/api/settings', { thinkingLevel: 'high' })).status).toBe(403)
  })

  it('lets a regular user read defaults and override only their own settings', async () => {
    const before = await (await fetch(`${baseUrl}/api/settings/me`, { headers: headers(bobToken) })).json() as {
      scope: string
      overrides: { thinkingLevel: string | null }
      effective: { thinkingLevel: string; language: string }
      defaults: { chatModel: { providerName: string } }
    }
    expect(before.scope).toBe('personal')
    expect(before.overrides.thinkingLevel).toBeNull()
    expect(before.effective).toMatchObject({ thinkingLevel: 'low', language: 'German' })
    expect(before.defaults.chatModel.providerName).toBe('One')

    const res = await put(bobToken, '/api/settings/me', {
      thinkingLevel: 'high',
      language: 'French',
      chatModel: { providerId: 'p2', modelId: 'm2' },
    })
    expect(res.status).toBe(200)
    const after = await res.json() as { effective: { thinkingLevel: string; chatModel: { providerId: string } } }
    expect(after.effective.thinkingLevel).toBe('high')
    expect(after.effective.chatModel.providerId).toBe('p2')

    const carol = await (await fetch(`${baseUrl}/api/settings/me`, { headers: headers(carolToken) })).json() as {
      effective: { thinkingLevel: string; language: string }
    }
    expect(carol.effective).toMatchObject({ thinkingLevel: 'low', language: 'German' })

    const reset = await put(bobToken, '/api/settings/me', { thinkingLevel: null, chatModel: null })
    expect(((await reset.json()) as { effective: { thinkingLevel: string } }).effective.thinkingLevel).toBe('low')
  })

  it('rejects unknown models and thinking levels', async () => {
    expect((await put(bobToken, '/api/settings/me', { chatModel: { providerId: 'p1', modelId: 'nope' } })).status).toBe(400)
    expect((await put(bobToken, '/api/settings/me', { thinkingLevel: 'ludicrous' })).status).toBe(400)
  })

  it('lists selectable chat models without credentials for every user', async () => {
    const res = await fetch(`${baseUrl}/api/settings/chat-models`, { headers: headers(bobToken) })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).not.toContain('secret-key')
    expect((JSON.parse(text) as { providers: { id: string }[] }).providers.map(p => p.id)).toEqual(['p1', 'p2'])
  })

  it('writes the global settings when an admin uses the own-settings endpoint', async () => {
    const res = await put(adminToken, '/api/settings/me', { thinkingLevel: 'medium' })
    expect(res.status).toBe(200)
    expect(JSON.parse(fs.readFileSync(path.join(tempDataDir, 'config', 'settings.json'), 'utf-8')).thinkingLevel).toBe('medium')
    const bob = await (await fetch(`${baseUrl}/api/settings/me`, { headers: headers(bobToken) })).json() as {
      effective: { thinkingLevel: string }
    }
    expect(bob.effective.thinkingLevel).toBe('medium')
  })
})
