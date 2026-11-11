import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { initDatabase } from './database.js'
import { ScheduledTaskStore, migrateScheduledTaskToolOverrides } from './scheduled-task-store.js'
import type { Database } from './database.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

describe('ScheduledTaskStore', () => {
  let db: Database
  let store: ScheduledTaskStore
  const tmpFiles: string[] = []

  function tmpDbPath(): string {
    const p = path.join(os.tmpdir(), `axiom-scheduled-task-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
    tmpFiles.push(p)
    return p
  }

  beforeEach(() => {
    db = initDatabase(tmpDbPath())
    store = new ScheduledTaskStore(db)
  })

  afterEach(() => {
    db.close()
    for (const f of tmpFiles) {
      try { fs.unlinkSync(f) } catch { /* ignore */ }
    }
    tmpFiles.length = 0
  })

  describe('create', () => {
    it('creates a scheduled task with required fields', () => {
      const task = store.create({
        name: 'Daily Summary',
        prompt: 'Summarize daily news',
        schedule: '0 9 * * *',
      })

      expect(task.id).toBeTruthy()
      expect(task.name).toBe('Daily Summary')
      expect(task.prompt).toBe('Summarize daily news')
      expect(task.schedule).toBe('0 9 * * *')
      expect(task.enabled).toBe(true)
      expect(task.provider).toBeNull()
      expect(task.createdAt).toBeTruthy()
      expect(task.updatedAt).toBeTruthy()
    })

    it('creates with optional fields', () => {
      const task = store.create({
        name: 'Custom Job',
        prompt: 'Do something',
        schedule: '*/15 * * * *',
        provider: 'openai',
        enabled: false,
      })

      expect(task.provider).toBe('openai')
      expect(task.enabled).toBe(false)
    })
  })

  describe('getById', () => {
    it('returns a task by ID', () => {
      const created = store.create({
        name: 'Find Me',
        prompt: 'test',
        schedule: '0 9 * * *',
      })
      const found = store.getById(created.id)
      expect(found).not.toBeNull()
      expect(found!.name).toBe('Find Me')
    })

    it('returns null for non-existent ID', () => {
      expect(store.getById('non-existent')).toBeNull()
    })
  })

  describe('list', () => {
    it('lists all tasks ordered by created_at DESC', () => {
      store.create({ name: 'Task 1', prompt: 'p1', schedule: '0 9 * * *' })
      store.create({ name: 'Task 2', prompt: 'p2', schedule: '0 10 * * *' })
      store.create({ name: 'Task 3', prompt: 'p3', schedule: '0 11 * * *' })

      const tasks = store.list()
      expect(tasks).toHaveLength(3)
      const names = tasks.map(t => t.name).sort()
      expect(names).toEqual(['Task 1', 'Task 2', 'Task 3'])
    })
  })

  describe('listEnabled', () => {
    it('only returns enabled tasks', () => {
      store.create({ name: 'Enabled', prompt: 'p1', schedule: '0 9 * * *', enabled: true })
      store.create({ name: 'Disabled', prompt: 'p2', schedule: '0 10 * * *', enabled: false })

      const enabled = store.listEnabled()
      expect(enabled).toHaveLength(1)
      expect(enabled[0].name).toBe('Enabled')
    })
  })

  describe('update', () => {
    it('updates name and schedule', () => {
      const task = store.create({ name: 'Old Name', prompt: 'test', schedule: '0 9 * * *' })
      const updated = store.update(task.id, { name: 'New Name', schedule: '0 10 * * *' })

      expect(updated).not.toBeNull()
      expect(updated!.name).toBe('New Name')
      expect(updated!.schedule).toBe('0 10 * * *')
    })

    it('updates enabled status', () => {
      const task = store.create({ name: 'Test', prompt: 'test', schedule: '0 9 * * *' })
      const updated = store.update(task.id, { enabled: false })
      expect(updated!.enabled).toBe(false)
    })

    it('updates last run fields', () => {
      const task = store.create({ name: 'Test', prompt: 'test', schedule: '0 9 * * *' })
      store.update(task.id, {
        lastRunAt: '2026-03-29 09:00:00',
        lastRunTaskId: 'task-123',
        lastRunStatus: 'completed',
      })

      const found = store.getById(task.id)!
      expect(found.lastRunAt).toBe('2026-03-29 09:00:00')
      expect(found.lastRunTaskId).toBe('task-123')
      expect(found.lastRunStatus).toBe('completed')
    })

    it('returns null for non-existent ID', () => {
      const result = store.update('non-existent', { name: 'New' })
      expect(result).toBeNull()
    })

    it('updates updated_at timestamp', () => {
      const task = store.create({ name: 'Test', prompt: 'test', schedule: '0 9 * * *' })
      // Small delay to ensure different timestamp
      const updated = store.update(task.id, { name: 'Updated' })
      expect(updated!.updatedAt).toBeTruthy()
    })
  })

  describe('delete', () => {
    it('deletes an existing task', () => {
      const task = store.create({ name: 'Delete Me', prompt: 'test', schedule: '0 9 * * *' })
      const deleted = store.delete(task.id)
      expect(deleted).toBe(true)
      expect(store.getById(task.id)).toBeNull()
    })

    it('returns false for non-existent ID', () => {
      expect(store.delete('non-existent')).toBe(false)
    })
  })

  describe('actionType', () => {
    it('defaults to task when not specified', () => {
      const task = store.create({
        name: 'Default Action',
        prompt: 'test',
        schedule: '0 9 * * *',
      })
      expect(task.actionType).toBe('task')
    })

    it('creates with injection action type', () => {
      const task = store.create({
        name: 'Reminder',
        prompt: 'Pack your bags!',
        schedule: '30 11 * * *',
        actionType: 'injection',
      })
      expect(task.actionType).toBe('injection')
    })

    it('creates with task action type', () => {
      const task = store.create({
        name: 'Heavy Job',
        prompt: 'Do complex work',
        schedule: '0 9 * * *',
        actionType: 'task',
      })
      expect(task.actionType).toBe('task')
    })

    it('updates action type', () => {
      const task = store.create({
        name: 'Switchable',
        prompt: 'test',
        schedule: '0 9 * * *',
        actionType: 'task',
      })
      const updated = store.update(task.id, { actionType: 'injection' })
      expect(updated!.actionType).toBe('injection')
    })
  })

  describe('codemode', () => {
    it('defaults to null (inherit) when not set', () => {
      const task = store.create({ name: 'Job', prompt: 'x', schedule: '0 9 * * *' })
      expect(task.codemode).toBeNull()
      expect(store.getById(task.id)!.codemode).toBeNull()
    })

    it('creates with an explicit override and reads it back', () => {
      const on = store.create({ name: 'On', prompt: 'x', schedule: '0 9 * * *', codemode: 'on' })
      expect(on.codemode).toBe('on')
      expect(store.getById(on.id)!.codemode).toBe('on')

      const off = store.create({ name: 'Off', prompt: 'x', schedule: '0 9 * * *', codemode: 'off' })
      expect(store.getById(off.id)!.codemode).toBe('off')
    })

    it('updates and resets the override', () => {
      const task = store.create({ name: 'Job', prompt: 'x', schedule: '0 9 * * *' })
      expect(store.update(task.id, { codemode: 'on' })!.codemode).toBe('on')
      expect(store.update(task.id, { codemode: 'off' })!.codemode).toBe('off')
      expect(store.update(task.id, { codemode: null })!.codemode).toBeNull()
    })
  })

  describe('migration', () => {
    it('adds the codemode column to legacy scheduled_tasks tables and stays idempotent', () => {
      const legacyPath = path.join(os.tmpdir(), `axiom-scheduled-task-legacy-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
      tmpFiles.push(legacyPath)
      try {
        const legacy = new BetterSqlite3(legacyPath)
        legacy.exec(`
          CREATE TABLE scheduled_tasks (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            prompt TEXT NOT NULL,
            schedule TEXT NOT NULL,
            provider TEXT,
            enabled INTEGER NOT NULL DEFAULT 1,
            tools_override TEXT,
            skills_override TEXT,
            system_prompt_override TEXT,
            last_run_at TEXT,
            last_run_task_id TEXT,
            last_run_status TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
          );
          INSERT INTO scheduled_tasks (id, name, prompt, schedule) VALUES ('legacy-1', 'Legacy', 'x', '0 9 * * *');
        `)
        legacy.close()

        const migrated = initDatabase(legacyPath)
        const rows = new ScheduledTaskStore(migrated).list()
        expect(rows).toHaveLength(1)
        expect(rows[0].id).toBe('legacy-1')
        expect(rows[0].codemode).toBeNull()
        migrated.close()

        // A second init on the same file must not fail or duplicate the column.
        const again = initDatabase(legacyPath)
        const cols = again.prepare('PRAGMA table_info(scheduled_tasks)').all() as { name: string }[]
        expect(cols.filter(c => c.name === 'codemode')).toHaveLength(1)
        again.close()
      } finally {
        for (const suffix of ['', '-wal', '-shm']) {
          try { fs.unlinkSync(legacyPath + suffix) } catch { /* ignore */ }
        }
      }
    })
  })

  describe('tool override migration', () => {
    const allEmailTools = ['email_list', 'email_folders', 'email_read', 'email_mark_read', 'email_mark_unread']

    /** A row as written before tool-name format versions existed (or with an explicit version). */
    function createStored(toolsOverride: string | null, version: number | null = null) {
      const task = store.create({ name: 'Free text name', prompt: 'p', schedule: '0 9 * * *' })
      db.prepare('UPDATE scheduled_tasks SET tools_override = ?, tools_override_version = ? WHERE id = ?')
        .run(toolsOverride, version, task.id)
      return store.getById(task.id)!
    }

    function migrateQuietly() {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        migrateScheduledTaskToolOverrides(db)
        return { log: log.mock.calls.map(call => String(call[0])), warn: warn.mock.calls.map(call => String(call[0])) }
      } finally {
        log.mockRestore()
        warn.mockRestore()
      }
    }

    const overrideOf = (id: string) => {
      const task = store.getById(id)!
      return { names: task.toolsOverride === null ? null : JSON.parse(task.toolsOverride) as string[], version: task.toolsOverrideVersion }
    }

    it('stamps rows written through the store with the current version', () => {
      const created = store.create({ name: 'Job', prompt: 'p', schedule: '0 9 * * *', toolsOverride: JSON.stringify(['email_read']) })
      expect(created.toolsOverrideVersion).toBe(2)
      expect(store.update(createStored(null).id, { toolsOverride: JSON.stringify(['shell']) })!.toolsOverrideVersion).toBe(2)
    })

    it('migrates unversioned and version 1 lists, reading email_read as the old single read tool', () => {
      const cases = {
        onlyRead: createStored(JSON.stringify(['email_read'])),
        allEmail: createStored(JSON.stringify(allEmailTools), 1),
        readAndCreateTask: createStored(JSON.stringify(['email_read', 'create_task'])),
        readAndReadFile: createStored(JSON.stringify(['email_read', 'read_file'])),
        empty: createStored(JSON.stringify([])),
        none: createStored(null),
        currentNamesOnly: createStored(JSON.stringify(['file_read', 'task_write', 'shell'])),
        renamed: createStored(JSON.stringify(['shell', 'write_file', 'send_file_to_user'])),
      }

      migrateQuietly()

      expect(overrideOf(cases.onlyRead.id)).toEqual({ names: [], version: 2 })
      expect(overrideOf(cases.allEmail.id)).toEqual({ names: ['email_read'], version: 2 })
      expect(overrideOf(cases.readAndCreateTask.id)).toEqual({ names: [], version: 2 })
      expect(overrideOf(cases.readAndReadFile.id)).toEqual({ names: ['file_read'], version: 2 })
      expect(overrideOf(cases.empty.id)).toEqual({ names: [], version: 2 })
      expect(overrideOf(cases.none.id)).toEqual({ names: null, version: 2 })
      expect(overrideOf(cases.currentNamesOnly.id)).toEqual({ names: ['file_read', 'task_write', 'shell'], version: 2 })
      expect(overrideOf(cases.renamed.id)).toEqual({ names: ['shell', 'file_write', 'file_send'], version: 2 })
    })

    it('never touches version 2 rows, so a second boot changes nothing', () => {
      const current = createStored(JSON.stringify(['email_read']), 2)
      const legacy = createStored(JSON.stringify(['read_file', 'file_read', 'generate_image']))

      const first = migrateQuietly()
      expect(overrideOf(current.id)).toEqual({ names: ['email_read'], version: 2 })
      expect(overrideOf(legacy.id)).toEqual({ names: ['file_read', 'image_generate'], version: 2 })
      expect(first.log).toContainEqual(expect.stringContaining('Migrated 1 cronjob tool override(s)'))

      const before = db.prepare('SELECT * FROM scheduled_tasks ORDER BY id').all()
      const second = migrateQuietly()
      expect(db.prepare('SELECT * FROM scheduled_tasks ORDER BY id').all()).toEqual(before)
      expect(second.log).toEqual([])
    })

    it('logs narrowed permissions with the task id and never the free-text name', () => {
      const partial = createStored(JSON.stringify(['shell', 'create_reminder', 'remove_cronjob']))
      const all = createStored(JSON.stringify(['list_cronjobs', 'get_cronjob', 'create_cronjob', 'edit_cronjob', 'remove_cronjob', 'create_reminder']))

      const { log } = migrateQuietly()

      expect(overrideOf(all.id).names).toEqual(['schedule_read', 'schedule_write'])
      expect(overrideOf(partial.id).names).toEqual(['shell'])
      expect(log).toContainEqual(expect.stringContaining(`Cronjob ${partial.id}: schedule_write stays enabled`))
      expect(log.some(line => line.includes(all.id))).toBe(false)
      expect(log.some(line => line.includes('Free text name'))).toBe(false)
    })

    it('leaves unparseable lists without a version so their runs fail closed', () => {
      const invalid = createStored('not-json')
      const { warn } = migrateQuietly()
      expect(warn).toContainEqual(expect.stringContaining(invalid.id))
      expect(store.getById(invalid.id)!).toMatchObject({ toolsOverride: 'not-json', toolsOverrideVersion: null })
    })

    it('runs as part of database initialization on a table without the version column', () => {
      const legacyPath = tmpDbPath()
      const legacy = new BetterSqlite3(legacyPath)
      legacy.exec(`
        CREATE TABLE scheduled_tasks (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          prompt TEXT NOT NULL,
          schedule TEXT NOT NULL,
          provider TEXT,
          enabled INTEGER NOT NULL DEFAULT 1,
          tools_override TEXT,
          skills_override TEXT,
          system_prompt_override TEXT,
          last_run_at TEXT,
          last_run_task_id TEXT,
          last_run_status TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO scheduled_tasks (id, name, prompt, schedule, tools_override)
          VALUES ('legacy-1', 'Legacy', 'x', '0 9 * * *', '["email_read","edit_file"]');
      `)
      legacy.close()

      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      try {
        const reopened = initDatabase(legacyPath)
        try {
          expect(new ScheduledTaskStore(reopened).getById('legacy-1')!)
            .toMatchObject({ toolsOverride: JSON.stringify(['file_edit']), toolsOverrideVersion: 2 })
        } finally {
          reopened.close()
        }
      } finally {
        log.mockRestore()
      }
    })
  })

  describe('schema', () => {
    it('has all required columns', () => {
      const cols = db.prepare("PRAGMA table_info(scheduled_tasks)").all() as { name: string }[]
      const colNames = cols.map(c => c.name)

      expect(colNames).toContain('id')
      expect(colNames).toContain('name')
      expect(colNames).toContain('prompt')
      expect(colNames).toContain('schedule')
      expect(colNames).toContain('action_type')
      expect(colNames).toContain('provider')
      expect(colNames).toContain('enabled')
      expect(colNames).toContain('tools_override')
      expect(colNames).toContain('tools_override_version')
      expect(colNames).toContain('skills_override')
      expect(colNames).toContain('system_prompt_override')
      expect(colNames).toContain('attached_skills')
      expect(colNames).toContain('thinking_level')
      expect(colNames).toContain('codemode')
      expect(colNames).toContain('last_run_at')
      expect(colNames).toContain('last_run_task_id')
      expect(colNames).toContain('last_run_status')
      expect(colNames).toContain('created_at')
      expect(colNames).toContain('updated_at')
    })
  })
})
