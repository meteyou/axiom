import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AgentCore, Database } from '@axiom/core'
import { initDatabase } from '@axiom/core'
import { createApp } from '../../../app.js'
import type { AppOptions } from '../../../app.js'
import { generateAccessToken } from '../../../auth.js'

let db: Database
let server: http.Server
let baseUrl: string
let adminToken: string
let userToken: string
let tempDataDir: string
let previousDataDir: string | undefined

const setTimeoutMinutes = vi.fn()
const refreshSystemPrompt = vi.fn()
const onHealthMonitorSettingsChanged = vi.fn()
const onConsolidationSettingsChanged = vi.fn()
const onAgentHeartbeatSettingsChanged = vi.fn()
const onTelegramSettingsChanged = vi.fn()

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-settings-route-'))
  process.env.DATA_DIR = tempDataDir

  db = initDatabase(':memory:')

  const getAgentCore = () => ({
    getSessionManager: () => ({ setTimeoutMinutes }),
    refreshSystemPrompt,
  }) as unknown as AgentCore

  server = http.createServer(createApp({
    db,
    getAgentCore,
    onAgentHeartbeatSettingsChanged,
    onTelegramSettingsChanged,
    healthMonitorService: {
      restart: onHealthMonitorSettingsChanged,
    } as unknown as NonNullable<AppOptions['healthMonitorService']>,
    consolidationScheduler: {
      restart: onConsolidationSettingsChanged,
    } as unknown as NonNullable<AppOptions['consolidationScheduler']>,
    agentHeartbeatService: {
      restart: vi.fn(),
    } as unknown as NonNullable<AppOptions['agentHeartbeatService']>,
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
  setTimeoutMinutes.mockClear()
  refreshSystemPrompt.mockClear()
  onHealthMonitorSettingsChanged.mockClear()
  onConsolidationSettingsChanged.mockClear()
  onAgentHeartbeatSettingsChanged.mockClear()
  onTelegramSettingsChanged.mockClear()
})

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` }
}

describe('settings route module', () => {
  it('keeps settings read behavior stable', async () => {
    const response = await fetch(`${baseUrl}/api/settings`, {
      headers: authHeaders(adminToken),
    })

    const body = await response.json() as {
      telegramBotToken: string
      factExtraction: { enabled: boolean; providerId: string; minSessionMessages: number }
      healthMonitor: { notifications: { downToFallback: boolean } }
    }

    expect(response.status).toBe(200)
    expect(body.telegramBotToken).toBe('')
    expect(body.factExtraction).toEqual({ enabled: false, providerId: '', minSessionMessages: 3 })
    expect(body.healthMonitor.notifications.downToFallback).toBe(true)
  })

  it('updates settings, persists to disk, and applies side effects', async () => {
    const response = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: {
        ...authHeaders(adminToken),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sessionTimeoutMinutes: 35,
        language: 'German',
        timezone: 'Europe/Berlin',
        healthMonitorIntervalMinutes: 9,
        telegramEnabled: true,
        telegramBotToken: 'token-123',
        memoryConsolidation: {
          enabled: true,
          runAtHour: 2,
          lookbackDays: 4,
        },
        agentHeartbeat: {
          enabled: true,
        },
      }),
    })

    const body = await response.json() as {
      sessionTimeoutMinutes: number
      language: string
      timezone: string
      healthMonitorIntervalMinutes: number
      telegramEnabled: boolean
      telegramBotToken: string
      memoryConsolidation: { enabled: boolean; runAtHour: number; lookbackDays: number }
      agentHeartbeat: { enabled: boolean }
    }

    expect(response.status).toBe(200)
    expect(body.sessionTimeoutMinutes).toBe(35)
    expect(body.language).toBe('German')
    expect(body.timezone).toBe('Europe/Berlin')
    expect(body.healthMonitorIntervalMinutes).toBe(9)
    expect(body.telegramEnabled).toBe(true)
    expect(body.telegramBotToken).toBe('token-123')
    expect(body.memoryConsolidation).toEqual({ enabled: true, runAtHour: 2, lookbackDays: 4, providerId: '' })
    expect(body.agentHeartbeat.enabled).toBe(true)

    expect(setTimeoutMinutes).toHaveBeenCalledWith(35)
    expect(refreshSystemPrompt).toHaveBeenCalled()
    expect(onHealthMonitorSettingsChanged).toHaveBeenCalled()
    expect(onConsolidationSettingsChanged).toHaveBeenCalled()
    expect(onAgentHeartbeatSettingsChanged).toHaveBeenCalled()
    expect(onTelegramSettingsChanged).toHaveBeenCalled()

    const settingsPath = path.join(tempDataDir, 'config', 'settings.json')
    const telegramPath = path.join(tempDataDir, 'config', 'telegram.json')

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as {
      sessionTimeoutMinutes: number
      language: string
      timezone: string
      healthMonitorIntervalMinutes: number
      memoryConsolidation: { enabled: boolean }
      agentHeartbeat: { enabled: boolean }
    }
    const telegram = JSON.parse(fs.readFileSync(telegramPath, 'utf-8')) as {
      enabled: boolean
      botToken: string
    }

    expect(settings.sessionTimeoutMinutes).toBe(35)
    expect(settings.language).toBe('German')
    expect(settings.timezone).toBe('Europe/Berlin')
    expect(settings.healthMonitorIntervalMinutes).toBe(9)
    expect(settings.memoryConsolidation.enabled).toBe(true)
    expect(settings.agentHeartbeat.enabled).toBe(true)
    expect(telegram.enabled).toBe(true)
    expect(telegram.botToken).toBe('token-123')
  })

  it('preserves validation and legacy payload handling', async () => {
    const invalidResponse = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: {
        ...authHeaders(adminToken),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tasks: {
          telegramDelivery: 'never',
        },
      }),
    })

    expect(invalidResponse.status).toBe(400)
    expect(await invalidResponse.json()).toEqual({
      error: 'tasks.telegramDelivery must be "auto" or "always"',
    })

    const legacyResponse = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: {
        ...authHeaders(adminToken),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        healthMonitor: {
          intervalMinutes: 12,
        },
      }),
    })

    expect(legacyResponse.status).toBe(200)
    const legacyBody = await legacyResponse.json() as { healthMonitorIntervalMinutes: number }
    expect(legacyBody.healthMonitorIntervalMinutes).toBe(12)
  })

  it('enforces authentication and admin boundaries', async () => {
    const unauthenticated = await fetch(`${baseUrl}/api/settings`)
    expect(unauthenticated.status).toBe(401)

    const nonAdmin = await fetch(`${baseUrl}/api/settings`, {
      headers: authHeaders(userToken),
    })
    expect(nonAdmin.status).toBe(403)
  })
})
