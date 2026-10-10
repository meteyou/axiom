import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import { AgentHeartbeatService, isUserHeartbeatEnabled, setUserHeartbeatEnabled } from './agent-heartbeat.js'
import type { ProviderConfig } from './provider-config.js'

const provider: ProviderConfig = {
  id: 'p', name: 'P', type: 'openai-completions', providerType: 'openai', provider: 'openai',
  baseUrl: 'https://x', apiKey: 'k', enabledModels: ['m'], status: 'connected',
}

describe('AgentHeartbeatService per user', () => {
  let db: Database
  let dataDir: string
  let originalDataDir: string | undefined
  let admin: number
  let bob: number
  let carol: number
  const create = vi.fn()
  const start = vi.fn()

  function addUser(username: string, role: string): number {
    return Number(db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(username, 'h', role).lastInsertRowid)
  }

  function writeSettings(settings: Record<string, unknown>) {
    fs.mkdirSync(path.join(dataDir, 'config'), { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'config', 'settings.json'), JSON.stringify(settings))
  }

  function writeHeartbeat(username: string, content: string) {
    const file = username === 'admin'
      ? path.join(dataDir, 'config', 'HEARTBEAT.md')
      : path.join(dataDir, 'users', username, 'HEARTBEAT.md')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }

  function createService(now = '2024-06-15T12:00:00Z') {
    return new AgentHeartbeatService({
      taskRuntime: { create, start },
      db,
      getDefaultProvider: () => provider,
      now: () => new Date(now),
    })
  }

  beforeEach(() => {
    originalDataDir = process.env.DATA_DIR
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-'))
    process.env.DATA_DIR = dataDir
    db = initDatabase(':memory:')
    admin = addUser('admin', 'admin')
    bob = addUser('bob', 'user')
    carol = addUser('carol', 'user')
    create.mockReset()
    start.mockReset()
    let n = 0
    create.mockImplementation(input => ({ id: `t${++n}`, ...input }))
    start.mockResolvedValue('x')
    writeSettings({ timezone: 'UTC', agentHeartbeat: { enabled: true, intervalMinutes: 60, nightMode: { enabled: true, startHour: 23, endHour: 8 } } })
    for (const name of ['admin', 'bob', 'carol']) writeHeartbeat(name, '- [ ] check things\n')
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (originalDataDir === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = originalDataDir
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it('bootstrap admin follows the global flag, other users default to off', () => {
    expect(isUserHeartbeatEnabled(db, admin, true)).toBe(true)
    expect(isUserHeartbeatEnabled(db, admin, false)).toBe(false)
    expect(isUserHeartbeatEnabled(db, bob, true)).toBe(false)
    setUserHeartbeatEnabled(db, bob, true)
    expect(isUserHeartbeatEnabled(db, bob, false)).toBe(true)
    setUserHeartbeatEnabled(db, admin, false)
    expect(isUserHeartbeatEnabled(db, admin, true)).toBe(false)
  })

  it('creates one owned task per eligible user referencing their own file', async () => {
    setUserHeartbeatEnabled(db, bob, true)
    const service = createService()
    service.start()
    const ids = await service.executeHeartbeatTick()
    service.stop()

    expect(ids).toHaveLength(2)
    const owners = create.mock.calls.map(c => c[0].ownerUserId)
    expect(owners).toEqual([admin, bob])
    expect(create.mock.calls[0][0].prompt).toContain(path.join(dataDir, 'config', 'HEARTBEAT.md'))
    expect(create.mock.calls[1][0].prompt).toContain(path.join(dataDir, 'users', 'bob', 'HEARTBEAT.md'))
  })

  it('skips disabled users, empty files and deleted users', async () => {
    setUserHeartbeatEnabled(db, bob, true)
    setUserHeartbeatEnabled(db, carol, true)
    writeHeartbeat('bob', '# Heartbeat\n- [ ]\n')
    db.prepare("UPDATE users SET deleted_at = datetime('now') WHERE id = ?").run(carol)
    const service = createService()
    service.start()
    await service.executeHeartbeatTick()
    service.stop()

    expect(create.mock.calls.map(c => c[0].ownerUserId)).toEqual([admin])
  })

  it('applies night mode in each user\'s timezone', async () => {
    setUserHeartbeatEnabled(db, bob, true)
    db.prepare('UPDATE users SET timezone = ? WHERE id = ?').run('Asia/Tokyo', bob)
    // 12:00 UTC is 21:00 in Tokyo; 15:00 UTC is 00:00 in Tokyo (night)
    const service = createService('2024-06-15T15:00:00Z')
    service.start()
    await service.executeHeartbeatTick()
    service.stop()

    expect(create.mock.calls.map(c => c[0].ownerUserId)).toEqual([admin])
  })

  it('does not schedule anything when the master switch is off', async () => {
    vi.useFakeTimers()
    writeSettings({ timezone: 'UTC', agentHeartbeat: { enabled: false } })
    setUserHeartbeatEnabled(db, bob, true)
    const service = createService()
    service.start()
    await vi.advanceTimersByTimeAsync(5 * 60 * 60 * 1000)
    service.stop()
    vi.useRealTimers()

    expect(create).not.toHaveBeenCalled()
  })
})
