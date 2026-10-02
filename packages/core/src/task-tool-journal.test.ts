import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import { TaskStore } from './task-store.js'
import { MAX_JOURNAL_FIELD_CHARS, TaskToolJournal, truncateJournalText } from './task-tool-journal.js'

describe('TaskToolJournal', () => {
  let db: Database
  let journal: TaskToolJournal
  let store: TaskStore
  let dbPath: string

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `axiom-journal-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
    db = initDatabase(dbPath)
    journal = new TaskToolJournal(db)
    store = new TaskStore(db)
  })

  afterEach(() => {
    db.close()
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(`${dbPath}${suffix}`) } catch { /* ignore */ }
    }
  })

  it('records a started call with its arguments before the tool finishes', () => {
    journal.recordStarted({
      taskId: 'task-1',
      sessionId: 'session-1',
      toolCallId: 'call-1',
      toolName: 'shell',
      args: { command: 'git push' },
    })

    const [entry] = journal.listForTask('task-1')
    expect(entry).toMatchObject({
      toolCallId: 'call-1',
      toolName: 'shell',
      args: '{"command":"git push"}',
      status: 'started',
      result: null,
      endedAt: null,
    })
  })

  it('finalizes the call with the model-facing result text', () => {
    journal.recordStarted({ taskId: 'task-1', sessionId: null, toolCallId: 'call-1', toolName: 'read_file', args: { path: 'a.txt' } })
    journal.recordEnded({
      taskId: 'task-1',
      toolCallId: 'call-1',
      isError: false,
      result: { content: [{ type: 'text', text: 'hello' }, { type: 'image', data: 'x' }], details: {} },
    })

    const [entry] = journal.listForTask('task-1')
    expect(entry.status).toBe('completed')
    expect(entry.result).toBe('hello\n[image]')
    expect(entry.endedAt).not.toBeNull()
  })

  it('marks failed calls as error', () => {
    journal.recordStarted({ taskId: 'task-1', sessionId: null, toolCallId: 'call-1', toolName: 'shell', args: {} })
    journal.recordEnded({ taskId: 'task-1', toolCallId: 'call-1', isError: true, result: 'Error: boom' })

    const [entry] = journal.listForTask('task-1')
    expect(entry.status).toBe('error')
    expect(entry.result).toBe('Error: boom')
  })

  it('leaves a call without an end event in started state (crash simulation)', () => {
    journal.recordStarted({ taskId: 'task-1', sessionId: null, toolCallId: 'call-1', toolName: 'read_file', args: {} })
    journal.recordEnded({ taskId: 'task-1', toolCallId: 'call-1', isError: false, result: 'done' })
    journal.recordStarted({ taskId: 'task-1', sessionId: null, toolCallId: 'call-2', toolName: 'email_send', args: { to: ['a@b.c'] } })

    const reopened = new TaskToolJournal(db)
    expect(reopened.listForTask('task-1').map(e => [e.toolCallId, e.status])).toEqual([
      ['call-1', 'completed'],
      ['call-2', 'started'],
    ])
  })

  it('truncates oversized args and results with a marker', () => {
    const huge = 'x'.repeat(MAX_JOURNAL_FIELD_CHARS + 100)
    journal.recordStarted({ taskId: 'task-1', sessionId: null, toolCallId: 'call-1', toolName: 'write_file', args: huge })
    journal.recordEnded({ taskId: 'task-1', toolCallId: 'call-1', isError: false, result: huge })

    const [entry] = journal.listForTask('task-1')
    expect(entry.args).toBe(truncateJournalText(huge))
    expect(entry.args!.endsWith('[truncated 100 chars]')).toBe(true)
    expect(entry.result!.endsWith('[truncated 100 chars]')).toBe(true)
  })

  it('replaces the row when a tool call id repeats within a task', () => {
    journal.recordStarted({ taskId: 'task-1', sessionId: null, toolCallId: 'call-1', toolName: 'read_file', args: { path: 'a' } })
    journal.recordEnded({ taskId: 'task-1', toolCallId: 'call-1', isError: false, result: 'a' })
    journal.recordStarted({ taskId: 'task-1', sessionId: null, toolCallId: 'call-2', toolName: 'list_files', args: {} })
    journal.recordStarted({ taskId: 'task-1', sessionId: null, toolCallId: 'call-1', toolName: 'shell', args: { command: 'ls' } })

    const entries = journal.listForTask('task-1')
    expect(entries.map(e => e.toolCallId)).toEqual(['call-2', 'call-1'])
    expect(entries[1]).toMatchObject({ toolName: 'shell', status: 'started', result: null, endedAt: null })
  })

  it('prunes rows of finished and deleted tasks but keeps running and paused ones', () => {
    const running = store.create({ name: 'running', prompt: 'p', triggerType: 'user' })
    const paused = store.create({ name: 'paused', prompt: 'p', triggerType: 'user' })
    store.update(paused.id, { status: 'paused' })
    const completed = store.create({ name: 'completed', prompt: 'p', triggerType: 'user' })
    store.update(completed.id, { status: 'completed' })

    for (const taskId of [running.id, paused.id, completed.id, 'deleted-task']) {
      journal.recordStarted({ taskId, sessionId: null, toolCallId: 'call-1', toolName: 'shell', args: {} })
    }

    expect(journal.pruneFinishedTasks()).toBe(2)
    expect(journal.listForTask(running.id)).toHaveLength(1)
    expect(journal.listForTask(paused.id)).toHaveLength(1)
    expect(journal.listForTask(completed.id)).toHaveLength(0)
    expect(journal.listForTask('deleted-task')).toHaveLength(0)
  })

  it('keeps existing journal rows when the database is initialized again', () => {
    journal.recordStarted({ taskId: 'task-1', sessionId: null, toolCallId: 'call-1', toolName: 'shell', args: {} })
    db.close()

    db = initDatabase(dbPath)
    expect(new TaskToolJournal(db).listForTask('task-1')).toHaveLength(1)
  })
})
