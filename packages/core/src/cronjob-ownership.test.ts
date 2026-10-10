import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import { ScheduledTaskStore, migrateScheduledTaskOwners } from './scheduled-task-store.js'
import {
  createCronjobTool,
  createReminderTool,
  editCronjobTool,
  getCronjobTool,
  listCronjobsTool,
  removeCronjobTool,
} from './cronjob-tools.js'
import type { CronjobToolsOptions } from './cronjob-tools.js'
import type { TaskRuntimeScheduleBoundary } from './task-runtime.js'

function buildBoundary(db: Database): TaskRuntimeScheduleBoundary {
  const store = new ScheduledTaskStore(db)
  return {
    create: (input) => store.create(input),
    getById: (id) => store.getById(id),
    list: (filters) => store.list(filters),
    listEnabled: (filters) => store.listEnabled(filters),
    update: (id, updates) => store.update(id, updates),
    delete: (id) => store.delete(id),
    register: () => {},
    unregister: () => {},
    triggerNow: async () => null,
    getActiveSchedules: () => [],
    start: () => {},
    stop: () => {},
    restart: () => {},
  }
}

async function run(tool: ReturnType<typeof createCronjobTool>, params: Record<string, unknown>): Promise<string> {
  const result = await tool.execute('call', params as never)
  return (result.content[0] as { text: string }).text
}

describe('cronjob ownership', () => {
  let db: Database
  let store: ScheduledTaskStore
  let boundary: TaskRuntimeScheduleBoundary

  beforeEach(() => {
    db = initDatabase(':memory:')
    db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1, 'admin', 'h', 'admin'), (2, 'alice', 'h', 'user'), (3, 'bob', 'h', 'user')").run()
    store = new ScheduledTaskStore(db)
    boundary = buildBoundary(db)
  })

  afterEach(() => db.close())

  const optionsFor = (id: number, role: 'admin' | 'user'): CronjobToolsOptions => ({
    taskRuntime: boundary,
    actor: { id, role },
    getUsername: (userId) => (db.prepare('SELECT username FROM users WHERE id = ?').get(userId) as { username: string } | undefined)?.username ?? null,
  })

  it('migrates ownerless cronjobs to the bootstrap admin and is idempotent', () => {
    const job = store.create({ name: 'n', prompt: 'p', schedule: '0 9 * * *', ownerUserId: 3 })
    db.prepare('UPDATE scheduled_tasks SET owner_user_id = NULL').run()
    migrateScheduledTaskOwners(db)
    expect(store.getById(job.id)!.ownerUserId).toBe(1)
    db.prepare('UPDATE scheduled_tasks SET owner_user_id = 3').run()
    migrateScheduledTaskOwners(db)
    expect(store.getById(job.id)!.ownerUserId).toBe(3)
  })

  it('defaults new cronjobs to the bootstrap admin and filters lists by owner', () => {
    expect(store.create({ name: 'a', prompt: 'p', schedule: '0 9 * * *' }).ownerUserId).toBe(1)
    store.create({ name: 'b', prompt: 'p', schedule: '0 9 * * *', ownerUserId: 2 })
    expect(store.list({ ownerUserId: 2 }).map(j => j.name)).toEqual(['b'])
    expect(store.list()).toHaveLength(2)
  })

  it('creates cronjobs and reminders for the acting user', async () => {
    const created = await run(createCronjobTool(optionsFor(2, 'user')), { name: 'mine', prompt: 'p', schedule: '0 9 * * *' })
    expect(created).toContain('created successfully')
    await run(createReminderTool(optionsFor(2, 'user')), { name: 'ping', message: 'Stand up', schedule: '0 9 * * *' })
    expect(store.list().map(j => j.ownerUserId)).toEqual([2, 2])
  })

  describe('foreign cronjobs', () => {
    let bobJob: string

    beforeEach(() => {
      bobJob = store.create({ name: 'Bob secret', prompt: 'private prompt', schedule: '0 9 * * *', ownerUserId: 3 }).id
      store.create({ name: 'Alice job', prompt: 'alice prompt', schedule: '0 9 * * *', ownerUserId: 2 })
    })

    it('hides them from regular users in every tool', async () => {
      const options = optionsFor(2, 'user')
      const list = await run(listCronjobsTool(options), {})
      expect(list).toContain('Alice job')
      expect(list).not.toContain('Bob secret')
      expect(await run(getCronjobTool(options), { id: bobJob })).toContain('No cronjob found')
      expect(await run(editCronjobTool(options), { id: bobJob, enabled: false })).toContain('not found')
      expect(await run(removeCronjobTool(options), { id: bobJob })).toContain('not found')
      expect(store.getById(bobJob)).not.toBeNull()
      expect(store.getById(bobJob)!.enabled).toBe(true)
    })

    it('shows the admin only name, owner and status', async () => {
      const options = optionsFor(1, 'admin')
      const list = await run(listCronjobsTool(options), {})
      expect(list).toContain('Bob secret')
      expect(list).toContain('Owner: bob')
      expect(list).not.toContain('private prompt')
      const detail = await run(getCronjobTool(options), { id: bobJob })
      expect(detail).toContain('Owner: bob')
      expect(detail).not.toContain('private prompt')
      expect(detail).not.toContain('Schedule')
    })

    it('lets the admin disable and delete but not edit', async () => {
      const options = optionsFor(1, 'admin')
      expect(await run(editCronjobTool(options), { id: bobJob, prompt: 'hijack' })).toContain('belongs to another user')
      expect(store.getById(bobJob)!.prompt).toBe('private prompt')
      const toggled = await run(editCronjobTool(options), { id: bobJob, enabled: false })
      expect(toggled).toContain('updated successfully')
      expect(toggled).toContain('Owner: bob')
      expect(toggled).toContain('DISABLED')
      expect(toggled).not.toContain('Schedule')
      expect(toggled).not.toContain('Action')
      expect(toggled).not.toContain('Provider')
      expect(store.getById(bobJob)!.enabled).toBe(false)
      expect(await run(removeCronjobTool(options), { id: bobJob })).toContain('has been deleted')
      expect(store.getById(bobJob)).toBeNull()
    })
  })
})
