import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
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
let userToken: string
let tempDataDir: string
let previousDataDir: string | undefined

const restartHealthMonitor = vi.fn()

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-providers-route-'))
  process.env.DATA_DIR = tempDataDir

  db = initDatabase(':memory:')

  server = http.createServer(createApp({
    db,
    healthMonitorService: {
      restart: restartHealthMonitor,
    } as unknown as NonNullable<Parameters<typeof createApp>[0]>['healthMonitorService'],
  }))

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
  restartHealthMonitor.mockClear()
})

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` }
}

describe('providers route module', () => {
  it('enforces authentication and admin boundary', async () => {
    const unauthenticated = await fetch(`${baseUrl}/api/providers`)
    expect(unauthenticated.status).toBe(401)

    const nonAdmin = await fetch(`${baseUrl}/api/providers`, {
      headers: authHeaders(userToken),
    })
    expect(nonAdmin.status).toBe(403)
  })

  it('keeps provider listing, update flow, and activation semantics stable', async () => {
    const firstCreate = await fetch(`${baseUrl}/api/providers`, {
      method: 'POST',
      headers: {
        ...authHeaders(adminToken),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Provider One',
        providerType: 'openai',
        apiKey: 'sk-provider-one',
        defaultModel: 'gpt-4o-mini',
      }),
    })

    expect(firstCreate.status).toBe(201)
    const firstBody = await firstCreate.json() as {
      provider: { id: string; name: string; apiKey: string; apiKeyMasked: string }
    }
    expect(firstBody.provider.name).toBe('Provider One')
    expect(firstBody.provider.apiKey).toBe('')
    expect(firstBody.provider.apiKeyMasked).toContain('••••••••')

    const secondCreate = await fetch(`${baseUrl}/api/providers`, {
      method: 'POST',
      headers: {
        ...authHeaders(adminToken),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Provider Two',
        providerType: 'openai',
        apiKey: 'sk-provider-two',
        defaultModel: 'gpt-4o-mini',
      }),
    })

    expect(secondCreate.status).toBe(201)
    const secondBody = await secondCreate.json() as { provider: { id: string; name: string } }

    const listBeforeUpdate = await fetch(`${baseUrl}/api/providers`, {
      headers: authHeaders(adminToken),
    })
    expect(listBeforeUpdate.status).toBe(200)
    const listBeforeUpdateBody = await listBeforeUpdate.json() as {
      providers: Array<{ id: string; name: string }>
      activeProvider: string | null
      activeModel: string | null
      presets: Record<string, unknown>
    }

    expect(listBeforeUpdateBody.providers).toHaveLength(2)
    expect(listBeforeUpdateBody.activeProvider).toBe(firstBody.provider.id)
    expect(listBeforeUpdateBody.activeModel).toBe('gpt-4o-mini')
    expect(listBeforeUpdateBody.presets['ollama-local']).toBeUndefined()
    expect(listBeforeUpdateBody.presets['ollama-cloud']).toBeUndefined()

    const updateResponse = await fetch(`${baseUrl}/api/providers/${secondBody.provider.id}`, {
      method: 'PUT',
      headers: {
        ...authHeaders(adminToken),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Provider Two Updated',
        defaultModel: 'gpt-4o-mini',
      }),
    })

    expect(updateResponse.status).toBe(200)
    const updateBody = await updateResponse.json() as {
      provider: { id: string; name: string; apiKeyMasked: string }
    }
    expect(updateBody.provider.id).toBe(secondBody.provider.id)
    expect(updateBody.provider.name).toBe('Provider Two Updated')
    expect(updateBody.provider.apiKeyMasked).toBe('(unchanged)')

    const activationResponse = await fetch(`${baseUrl}/api/providers/${secondBody.provider.id}/activate`, {
      method: 'POST',
      headers: {
        ...authHeaders(adminToken),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ modelId: 'gpt-4o-mini' }),
    })

    expect(activationResponse.status).toBe(200)
    const activationBody = await activationResponse.json() as {
      activeProvider: string
      activeModel: string | null
    }
    expect(activationBody.activeProvider).toBe(secondBody.provider.id)
    expect(activationBody.activeModel).toBe('gpt-4o-mini')

    const listAfterActivation = await fetch(`${baseUrl}/api/providers`, {
      headers: authHeaders(adminToken),
    })
    const listAfterActivationBody = await listAfterActivation.json() as {
      activeProvider: string | null
      activeModel: string | null
    }
    expect(listAfterActivationBody.activeProvider).toBe(secondBody.provider.id)
    expect(listAfterActivationBody.activeModel).toBe('gpt-4o-mini')

    expect(restartHealthMonitor).toHaveBeenCalled()

    const setFallback = await fetch(`${baseUrl}/api/providers/fallback`, {
      method: 'PUT',
      headers: {
        ...authHeaders(adminToken),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ providerId: firstBody.provider.id, modelId: 'gpt-4o-mini' }),
    })
    expect(setFallback.status).toBe(200)
    expect(await setFallback.json()).toMatchObject({
      fallbackProvider: firstBody.provider.id,
      fallbackModel: 'gpt-4o-mini',
    })

    const clearFallback = await fetch(`${baseUrl}/api/providers/fallback`, {
      method: 'PUT',
      headers: {
        ...authHeaders(adminToken),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ providerId: null }),
    })
    expect(clearFallback.status).toBe(200)
    expect(await clearFallback.json()).toMatchObject({
      fallbackProvider: null,
      fallbackModel: null,
    })
  })

  it('keeps provider validation and not-found responses stable', async () => {
    const invalidCreate = await fetch(`${baseUrl}/api/providers`, {
      method: 'POST',
      headers: {
        ...authHeaders(adminToken),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Invalid Provider',
        providerType: 'invalid-provider',
        defaultModel: 'model',
      }),
    })

    expect(invalidCreate.status).toBe(400)
    expect(await invalidCreate.json()).toEqual({
      error: expect.stringContaining('Invalid provider type. Must be one of:'),
    })

    const invalidFallback = await fetch(`${baseUrl}/api/providers/fallback`, {
      method: 'PUT',
      headers: {
        ...authHeaders(adminToken),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ providerId: '' }),
    })

    expect(invalidFallback.status).toBe(400)
    expect(await invalidFallback.json()).toEqual({
      error: 'providerId must be a non-empty string or null',
    })

    const activateMissing = await fetch(`${baseUrl}/api/providers/missing-provider/activate`, {
      method: 'POST',
      headers: authHeaders(adminToken),
    })
    expect(activateMissing.status).toBe(404)

    const testMissing = await fetch(`${baseUrl}/api/providers/missing-provider/test`, {
      method: 'POST',
      headers: authHeaders(adminToken),
    })
    expect(testMissing.status).toBe(404)
    expect(await testMissing.json()).toEqual({ error: 'Provider not found' })
  })
})
