import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import { TaskStore } from './task-store.js'
import { ScheduledTaskStore } from './scheduled-task-store.js'
import { TaskScheduler } from './task-scheduler.js'
import type { TaskRunner } from './task-runner.js'
import { resolveUserScope } from './user-scope.js'
import { appendToDailyFile, formatDateKey, formatTimeKey } from './memory.js'
import { resolveOwnerTimezone, updateUserSettings } from './user-settings.js'

describe('per-user timezone', () => {
  let db: Database
  let dataDir: string
  let previousDataDir: string | undefined
  let scheduler: TaskScheduler
  let store: ScheduledTaskStore
  let adminId: number
  let bobId: number

  function addUser(username: string, role: string): number {
    return Number(db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(username, 'h', role).lastInsertRowid)
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-01-15T00:00:00Z'))
    previousDataDir = process.env.DATA_DIR
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-tz-'))
    process.env.DATA_DIR = dataDir
    fs.mkdirSync(path.join(dataDir, 'config'), { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'config', 'settings.json'), JSON.stringify({ timezone: 'UTC' }))
    db = initDatabase(':memory:')
    adminId = addUser('admin', 'admin')
    bobId = addUser('bob', 'user')
    store = new ScheduledTaskStore(db)
    scheduler = new TaskScheduler({
      db,
      taskStore: new TaskStore(db),
      taskRunner: { startTask: vi.fn(), getStore: () => new TaskStore(db) } as unknown as TaskRunner,
      getDefaultProvider: () => null,
      resolveProvider: () => null,
    })
  })

  afterEach(() => {
    scheduler.dispose()
    vi.useRealTimers()
    db.close()
    if (previousDataDir === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDir
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it('resolves the effective timezone per owner', () => {
    updateUserSettings(db, bobId, { timezone: 'Asia/Tokyo' })
    expect(resolveOwnerTimezone(db, bobId)).toBe('Asia/Tokyo')
    expect(resolveOwnerTimezone(db, adminId)).toBe('UTC')
    expect(resolveOwnerTimezone(db, null)).toBe('UTC')
    expect(resolveUserScope(db, bobId)?.settings.timezone).toBe('Asia/Tokyo')
  })

  it('fires "0 7 * * *" at 07:00 local time of the owner', () => {
    updateUserSettings(db, bobId, { timezone: 'Asia/Tokyo' })
    const adminJob = store.create({ name: 'a', prompt: 'p', schedule: '0 7 * * *', ownerUserId: adminId })
    const bobJob = store.create({ name: 'b', prompt: 'p', schedule: '0 7 * * *', ownerUserId: bobId })
    scheduler.start()

    const next = (id: string) => scheduler.getActiveSchedules().find(s => s.id === id)?.nextRunTime.toISOString()
    expect(next(adminJob.id)).toBe('2025-01-15T07:00:00.000Z')
    expect(next(bobJob.id)).toBe('2025-01-15T22:00:00.000Z')
  })

  it('reschedules the cronjobs of a user whose timezone changed', () => {
    updateUserSettings(db, bobId, { timezone: 'Asia/Tokyo' })
    const bobJob = store.create({ name: 'b', prompt: 'p', schedule: '0 7 * * *', ownerUserId: bobId })
    const adminJob = store.create({ name: 'a', prompt: 'p', schedule: '0 7 * * *', ownerUserId: adminId })
    scheduler.start()

    updateUserSettings(db, bobId, { timezone: 'America/New_York' })
    scheduler.rescheduleOwner(bobId)

    const next = (id: string) => scheduler.getActiveSchedules().find(s => s.id === id)?.nextRunTime.toISOString()
    expect(next(bobJob.id)).toBe('2025-01-15T12:00:00.000Z')
    expect(next(adminJob.id)).toBe('2025-01-15T07:00:00.000Z')
  })

  it('writes daily-note dates and headings in the given timezone', () => {
    const dailyDir = path.join(dataDir, 'daily')
    const instant = new Date('2025-01-15T23:30:00Z')
    appendToDailyFile(`\n## ${formatTimeKey(instant, 'Asia/Tokyo')}\n\nnote\n`, instant, undefined, dailyDir, 'Asia/Tokyo')
    const file = path.join(dailyDir, '2025-01-16.md')
    expect(fs.existsSync(file)).toBe(true)
    expect(fs.readFileSync(file, 'utf-8')).toContain('## 08:30')
    expect(formatDateKey(instant, 'America/New_York')).toBe('2025-01-15')
  })
})
