import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { initDatabase } from './database.js'
import { ScheduledTaskStore } from './scheduled-task-store.js'
import type { ScheduledTask } from './scheduled-task-store.js'
import { createScheduleReadTool, createScheduleWriteTool } from './schedule-tools.js'
import type { TaskRuntimeScheduleBoundary } from './task-runtime.js'
import type { Database } from './database.js'

/**
 * Build a thin in-memory TaskRuntimeScheduleBoundary backed by the real
 * ScheduledTaskStore. register/unregister/triggerNow/getActiveSchedules are
 * stubs — the cronjob tools don't exercise the scheduler, only the store.
 */
function buildScheduleBoundary(db: Database): TaskRuntimeScheduleBoundary {
  const store = new ScheduledTaskStore(db)
  return {
    create: (input) => store.create(input),
    getById: (id) => store.getById(id),
    list: () => store.list(),
    listEnabled: () => store.listEnabled(),
    update: (id, updates) => store.update(id, updates),
    delete: (id) => store.delete(id),
    register: () => {},
    unregister: () => {},
    rescheduleOwner: () => {},
    triggerNow: async () => null,
    getActiveSchedules: () => [],
    start: () => {},
    stop: () => {},
    restart: () => {},
  }
}

describe('schedule_write: attachedSkills', () => {
  let db: Database
  let dbPath: string
  let boundary: TaskRuntimeScheduleBoundary

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `axiom-cronjob-tools-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
    db = initDatabase(dbPath)
    boundary = buildScheduleBoundary(db)
  })

  afterEach(() => {
    db.close()
    try { fs.unlinkSync(dbPath) } catch { /* ignore */ }
  })

  it('create persists attached_skills when provided', async () => {
    const tool = createScheduleWriteTool({ taskRuntime: boundary })
    const result = await tool.execute('call-1', {
      action: 'create',
      name: 'Daily Nitter Scan',
      prompt: 'Scan Nitter for mentions.',
      schedule: '0 9 * * *',
      attached_skills: ['nitter', 'reddit'],
    })
    expect(result.details?.error).not.toBe(true)
    const details = result.details as { cronjobId: string; attachedSkills: string[] | null }
    expect(details.attachedSkills).toEqual(['nitter', 'reddit'])

    const stored = boundary.getById(details.cronjobId)!
    expect(stored.attachedSkills).toEqual(['nitter', 'reddit'])
  })

  it('create normalizes attached_skills (dedupe + trim + drop empty)', async () => {
    const tool = createScheduleWriteTool({ taskRuntime: boundary })
    const result = await tool.execute('call-2', {
      action: 'create',
      name: 'N',
      prompt: 'P',
      schedule: '0 9 * * *',
      attached_skills: ['nitter', '  nitter  ', '', 'reddit'],
    })
    const details = result.details as { cronjobId: string; attachedSkills: string[] | null }
    expect(details.attachedSkills).toEqual(['nitter', 'reddit'])
  })

  it('create without attached_skills stores null (backward-compatible)', async () => {
    const tool = createScheduleWriteTool({ taskRuntime: boundary })
    const result = await tool.execute('call-3', {
      action: 'create',
      name: 'Legacy',
      prompt: 'P',
      schedule: '0 9 * * *',
    })
    const details = result.details as { cronjobId: string; attachedSkills: string[] | null }
    expect(details.attachedSkills).toBeNull()

    const stored = boundary.getById(details.cronjobId)!
    expect(stored.attachedSkills).toBeNull()
  })

  it('edit replaces the attached_skills list', async () => {
    // Seed a cronjob
    const seed: ScheduledTask = boundary.create({
      name: 'Seed',
      prompt: 'P',
      schedule: '0 9 * * *',
      attachedSkills: ['nitter'],
    })

    const edit = createScheduleWriteTool({ taskRuntime: boundary })
    const result = await edit.execute('call-4', {
      action: 'edit',
      id: seed.id,
      attached_skills: ['reddit', 'wiki'],
    })
    const details = result.details as { attachedSkills: string[] | null }
    expect(details.attachedSkills).toEqual(['reddit', 'wiki'])

    const stored = boundary.getById(seed.id)!
    expect(stored.attachedSkills).toEqual(['reddit', 'wiki'])
  })

  it('edit with attached_skills: [] clears the list', async () => {
    const seed = boundary.create({
      name: 'Seed',
      prompt: 'P',
      schedule: '0 9 * * *',
      attachedSkills: ['nitter', 'reddit'],
    })

    const edit = createScheduleWriteTool({ taskRuntime: boundary })
    const result = await edit.execute('call-5', {
      action: 'edit',
      id: seed.id,
      attached_skills: [],
    })
    const details = result.details as { attachedSkills: string[] | null }
    expect(details.attachedSkills).toBeNull()

    const stored = boundary.getById(seed.id)!
    expect(stored.attachedSkills).toBeNull()
  })

  it('edit without attached_skills leaves the list unchanged', async () => {
    const seed = boundary.create({
      name: 'Seed',
      prompt: 'P',
      schedule: '0 9 * * *',
      attachedSkills: ['nitter'],
    })

    const edit = createScheduleWriteTool({ taskRuntime: boundary })
    await edit.execute('call-6', {
      action: 'edit',
      id: seed.id,
      name: 'Seed renamed',
    })

    const stored = boundary.getById(seed.id)!
    expect(stored.name).toBe('Seed renamed')
    expect(stored.attachedSkills).toEqual(['nitter'])
  })
})

function text(result: { content: unknown[] }): string {
  return (result.content[0] as { text: string }).text
}

describe('schedule_write / schedule_read', () => {
  let db: Database
  let dbPath: string
  let boundary: TaskRuntimeScheduleBoundary

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `axiom-schedule-tools-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
    db = initDatabase(dbPath)
    boundary = buildScheduleBoundary(db)
  })

  afterEach(() => {
    db.close()
    try { fs.unlinkSync(dbPath) } catch { /* ignore */ }
  })

  it('creates a task cronjob by default and a static reminder for type=reminder', async () => {
    const write = createScheduleWriteTool({ taskRuntime: boundary })
    const task = await write.execute('c1', { action: 'create', name: 'Digest', prompt: 'Summarize my inbox.', schedule: '0 9 * * *' })
    expect(text(task)).toContain('Cronjob created successfully')
    const reminder = await write.execute('c2', { action: 'create', type: 'reminder', name: 'Leave', prompt: 'Time to leave for the train', schedule: '30 17 * * *' })
    expect(text(reminder)).toContain('Reminder created successfully')

    const stored = boundary.list()
    expect(stored.map(job => [job.name, job.actionType])).toEqual(expect.arrayContaining([['Digest', 'task'], ['Leave', 'injection']]))
  })

  it('rejects dynamic work for type=reminder', async () => {
    const write = createScheduleWriteTool({ taskRuntime: boundary })
    const result = await write.execute('c1', { action: 'create', type: 'reminder', name: 'Weather', prompt: 'Check the current weather', schedule: '0 7 * * *' })
    expect(result.details).toMatchObject({ error: true, suggestedType: 'task' })
    expect(text(result)).toContain('type "task"')
    expect(boundary.list()).toHaveLength(0)
  })

  it('rejects agent-run parameters for type=reminder', async () => {
    const write = createScheduleWriteTool({ taskRuntime: boundary })
    const result = await write.execute('c1', { action: 'create', type: 'reminder', name: 'Ping', prompt: 'Stand up', schedule: '0 9 * * *', attached_skills: ['x'] })
    expect(text(result)).toContain('attached_skills is not supported for type=reminder')
    expect(boundary.list()).toHaveLength(0)
  })

  it('rejects turning a cronjob into a reminder when its prompt is dynamic', async () => {
    const seed = boundary.create({ name: 'Digest', prompt: 'Fetch the latest news', schedule: '0 9 * * *' })
    const write = createScheduleWriteTool({ taskRuntime: boundary })
    const result = await write.execute('c1', { action: 'edit', id: seed.id, type: 'reminder' })
    expect(result.details).toMatchObject({ error: true })
    expect(boundary.getById(seed.id)!.actionType).toBe('task')
  })

  it('reports missing per-action fields precisely', async () => {
    const write = createScheduleWriteTool({ taskRuntime: boundary })
    expect(text(await write.execute('c1', { action: 'create', name: 'N', prompt: 'P' }))).toBe('Error: schedule is required for action=create.')
    expect(text(await write.execute('c2', { action: 'create' }))).toBe('Error: name, prompt, schedule are required for action=create.')
    expect(text(await write.execute('c3', { action: 'remove' }))).toBe('Error: id is required for action=remove.')
    expect(text(await createScheduleReadTool({ taskRuntime: boundary }).execute('c4', { action: 'get' }))).toBe('Error: id is required for action=get.')
  })

  it('rejects unknown and invalid values', async () => {
    const write = createScheduleWriteTool({ taskRuntime: boundary })
    expect(text(await write.execute('c1', { action: 'list' }))).toContain('Unknown action "list" for schedule_write. Valid actions: create, edit, remove.')
    expect(text(await write.execute('c2', { action: 'create', type: 'injection', name: 'N', prompt: 'P', schedule: '0 9 * * *' }))).toContain('Invalid type "injection"')
  })

  it('lists, gets and removes schedules', async () => {
    const seed = boundary.create({ name: 'Seed', prompt: 'The full prompt', schedule: '0 9 * * *' })
    const read = createScheduleReadTool({ taskRuntime: boundary })
    expect(text(await read.execute('c1', { action: 'list' }))).toContain('Seed')
    expect(text(await read.execute('c2', { action: 'list' }))).not.toContain('The full prompt')
    expect(text(await read.execute('c3', { action: 'get', id: seed.id }))).toContain('The full prompt')

    const removed = await createScheduleWriteTool({ taskRuntime: boundary }).execute('c4', { action: 'remove', id: seed.id })
    expect(text(removed)).toContain('has been deleted')
    expect(boundary.getById(seed.id)).toBeNull()
  })

  it('declares read actions safe and write actions unsafe for replay', () => {
    expect(createScheduleReadTool({ taskRuntime: boundary }).actionReplayPolicies).toEqual({ list: 'safe', get: 'safe' })
    expect(createScheduleWriteTool({ taskRuntime: boundary }).actionReplayPolicies).toEqual({ create: 'unsafe', edit: 'unsafe', remove: 'unsafe' })
  })
})
