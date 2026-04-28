import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { Database, Task } from '@openagent/core'
import { initDatabase, initTasksTable, TaskStore } from '@openagent/core'
import { createApp } from '../../../app.js'
import { generateAccessToken } from '../../../auth.js'

let db: Database
let server: http.Server
let baseUrl: string
let token: string
let tempDataDir: string
let previousDataDir: string | undefined

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openagent-tasks-route-'))
  process.env.DATA_DIR = tempDataDir

  db = initDatabase(':memory:')
  initTasksTable(db)

  server = http.createServer(createApp({ db }))
  await new Promise<void>((resolve) => server.listen(0, resolve))

  const port = (server.address() as { port: number }).port
  baseUrl = `http://127.0.0.1:${port}`
  token = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })
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
  db.prepare('DELETE FROM tool_calls').run()
  db.prepare('DELETE FROM chat_messages').run()
  db.prepare('DELETE FROM tasks').run()
})

function authHeaders() {
  return { Authorization: `Bearer ${token}` }
}

function createTask(input?: Partial<{
  name: string
  prompt: string
  triggerType: Task['triggerType']
  sessionId: string
  provider: string
  model: string
  isDefaultModel: boolean
}>) {
  const store = new TaskStore(db)
  return store.create({
    name: input?.name ?? 'Task',
    prompt: input?.prompt ?? 'Do something',
    triggerType: input?.triggerType ?? 'user',
    sessionId: input?.sessionId,
    provider: input?.provider,
    model: input?.model,
    isDefaultModel: input?.isDefaultModel,
  })
}

describe('tasks route module', () => {
  it('lists tasks with pagination and filters', async () => {
    const store = new TaskStore(db)
    const runningTask = createTask({ name: 'Running task', triggerType: 'user' })
    const completedTask = createTask({ name: 'Completed task', triggerType: 'agent' })

    store.update(completedTask.id, {
      status: 'completed',
      resultStatus: 'completed',
      completedAt: '2026-03-27 12:00:00',
    })

    const res = await fetch(`${baseUrl}/api/tasks?page=1&limit=1&status=completed`, {
      headers: authHeaders(),
    })

    const body = await res.json() as {
      tasks: Task[]
      pagination: { page: number; limit: number; total: number; totalPages: number }
    }

    expect(res.status).toBe(200)
    expect(body.tasks).toHaveLength(1)
    expect(body.tasks[0]?.id).toBe(completedTask.id)
    expect(body.pagination).toEqual({
      page: 1,
      limit: 1,
      total: 1,
      totalPages: 1,
    })
    expect(body.tasks[0]?.id).not.toBe(runningTask.id)
  })

  it('returns provider filter options from historical task rows in the selected date range', async () => {
    const defaultTask = createTask({
      name: 'Default task',
      provider: 'ChatGPT Plus',
      model: 'gpt-5.4-mini',
      isDefaultModel: true,
    })
    const explicitTask = createTask({
      name: 'Explicit task',
      provider: 'OpenAI GPT-5.4',
      model: 'gpt-5.4',
      isDefaultModel: false,
    })
    const explicitDefaultProviderTask = createTask({
      name: 'Explicit default provider task',
      provider: 'ChatGPT Plus',
      model: 'gpt-5.4-mini',
      isDefaultModel: false,
    })
    const outsideRangeTask = createTask({
      name: 'Outside task',
      provider: 'Old Provider',
      model: 'old-model',
      isDefaultModel: false,
    })

    db.prepare('UPDATE tasks SET created_at = ? WHERE id = ?').run('2026-04-14 23:00:00', defaultTask.id)
    db.prepare('UPDATE tasks SET created_at = ? WHERE id = ?').run('2026-04-09 23:00:00', explicitTask.id)
    db.prepare('UPDATE tasks SET created_at = ? WHERE id = ?').run('2026-04-14 23:30:00', explicitDefaultProviderTask.id)
    db.prepare('UPDATE tasks SET created_at = ? WHERE id = ?').run('2026-03-31 23:00:00', outsideRangeTask.id)

    const res = await fetch(`${baseUrl}/api/tasks?created_from=2026-04-01&created_to=2026-04-28`, {
      headers: authHeaders(),
    })

    const body = await res.json() as {
      providerOptions: Array<{ provider: string | null; model: string | null; isDefaultModel: boolean | null }>
    }

    expect(res.status).toBe(200)
    expect(body.providerOptions.filter(option =>
      option.provider === 'ChatGPT Plus' && option.model === 'gpt-5.4-mini',
    )).toEqual([{
      provider: 'ChatGPT Plus',
      model: 'gpt-5.4-mini',
      isDefaultModel: true,
    }])
    expect(body.providerOptions).toContainEqual({
      provider: 'OpenAI GPT-5.4',
      model: 'gpt-5.4',
      isDefaultModel: false,
    })
    expect(body.providerOptions).not.toContainEqual({
      provider: 'Old Provider',
      model: 'old-model',
      isDefaultModel: false,
    })
  })

  it('returns 400 for invalid filters', async () => {
    const res = await fetch(`${baseUrl}/api/tasks?status=not-a-valid-status`, {
      headers: authHeaders(),
    })

    const body = await res.json() as { error: string }

    expect(res.status).toBe(400)
    expect(body.error).toContain('Invalid status filter')
  })

  it('returns 400 when the created date range is inverted', async () => {
    const res = await fetch(`${baseUrl}/api/tasks?created_from=2026-04-28&created_to=2026-04-01`, {
      headers: authHeaders(),
    })

    const body = await res.json() as { error: string }

    expect(res.status).toBe(400)
    expect(body.error).toContain('created_to must be greater than or equal to created_from')
  })

  it('returns 400 when a created date is not a real calendar date', async () => {
    const res = await fetch(`${baseUrl}/api/tasks?created_from=2026-04-31`, {
      headers: authHeaders(),
    })

    const body = await res.json() as { error: string }

    expect(res.status).toBe(400)
    expect(body.error).toContain('Invalid created_from filter')
  })

  it('returns task details and 404 for missing task', async () => {
    const task = createTask({ name: 'Detail task' })

    const getRes = await fetch(`${baseUrl}/api/tasks/${task.id}`, {
      headers: authHeaders(),
    })

    const getBody = await getRes.json() as { task: Task }

    expect(getRes.status).toBe(200)
    expect(getBody.task.id).toBe(task.id)
    expect(getBody.task.name).toBe('Detail task')

    const missingRes = await fetch(`${baseUrl}/api/tasks/missing-task-id`, {
      headers: authHeaders(),
    })

    expect(missingRes.status).toBe(404)
  })

  it('returns merged task events in chronological order', async () => {
    const task = createTask({ name: 'Events task', sessionId: 'task-events-session' })

    db.prepare(
      'INSERT INTO tool_calls (session_id, tool_name, input, output, duration_ms, status, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'task-events-session',
      'bash',
      '{"command":"ls"}',
      '{"stdout":"file.txt"}',
      20,
      'success',
      '2026-03-27 10:00:00',
    )

    db.prepare(
      'INSERT INTO chat_messages (session_id, role, content, metadata, timestamp) VALUES (?, ?, ?, ?, ?)',
    ).run(
      'task-events-session',
      'system',
      'System note',
      null,
      '2026-03-27 10:00:01',
    )

    db.prepare(
      'INSERT INTO chat_messages (session_id, role, content, metadata, timestamp) VALUES (?, ?, ?, ?, ?)',
    ).run(
      'task-events-session',
      'assistant',
      'Assistant response',
      JSON.stringify({ thinking: 'step by step' }),
      '2026-03-27 10:00:02',
    )

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/events`, {
      headers: authHeaders(),
    })

    const body = await res.json() as {
      task: { id: string; name: string; status: string }
      events: Array<{ type: string; timestamp: string; role?: string; toolName?: string }>
    }

    expect(res.status).toBe(200)
    expect(body.task.id).toBe(task.id)
    expect(body.events).toHaveLength(3)
    expect(body.events.map(event => event.type)).toEqual(['tool_call', 'message', 'message'])
    expect(body.events[0]?.toolName).toBe('bash')
    expect(body.events[1]?.role).toBe('system')
    expect(body.events[2]?.role).toBe('assistant')
  })

  it('falls back to raw string when task message metadata contains malformed JSON', async () => {
    const task = createTask({ name: 'Corrupted metadata task', sessionId: 'task-events-corrupt' })

    db.prepare(
      'INSERT INTO chat_messages (session_id, role, content, metadata, timestamp) VALUES (?, ?, ?, ?, ?)',
    ).run(
      'task-events-corrupt',
      'assistant',
      'Assistant response',
      '{"thinking":',
      '2026-03-27 10:00:02',
    )

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/events`, {
      headers: authHeaders(),
    })

    const body = await res.json() as {
      task: { id: string }
      events: Array<{ type: string; role?: string; metadata?: unknown }>
    }

    // A single malformed metadata row must not crash the endpoint; instead the
    // service falls back to the raw string so the rest of the timeline loads.
    expect(res.status).toBe(200)
    expect(body.events).toHaveLength(1)
    expect(body.events[0]?.type).toBe('message')
    expect(body.events[0]?.role).toBe('assistant')
    expect(body.events[0]?.metadata).toBe('{"thinking":')
  })

  it('kills running tasks and prevents killing non-running tasks', async () => {
    const store = new TaskStore(db)
    const runningTask = createTask({ name: 'Kill me' })

    const killRes = await fetch(`${baseUrl}/api/tasks/${runningTask.id}/kill`, {
      method: 'POST',
      headers: authHeaders(),
    })

    const killBody = await killRes.json() as { task: Task }

    expect(killRes.status).toBe(200)
    expect(killBody.task.status).toBe('failed')
    expect(killBody.task.resultSummary).toBe('Killed by user from web UI')
    expect(killBody.task.completedAt).toBeTruthy()

    const completedTask = createTask({ name: 'Already done' })
    store.update(completedTask.id, {
      status: 'completed',
      resultStatus: 'completed',
      completedAt: '2026-03-27 10:00:00',
    })

    const blockedKillRes = await fetch(`${baseUrl}/api/tasks/${completedTask.id}/kill`, {
      method: 'POST',
      headers: authHeaders(),
    })

    const blockedKillBody = await blockedKillRes.json() as { error: string }

    expect(blockedKillRes.status).toBe(400)
    expect(blockedKillBody.error).toBe("Cannot kill task with status 'completed'. Only running tasks can be killed.")
  })

  describe('restart endpoint', () => {
    it('returns 404 when the original task does not exist', async () => {
      const res = await fetch(`${baseUrl}/api/tasks/nope/restart`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })

      expect(res.status).toBe(404)
    })

    it('returns 409 when the original task is still running', async () => {
      const task = createTask({ name: 'Still running' })

      const res = await fetch(`${baseUrl}/api/tasks/${task.id}/restart`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })

      const body = await res.json() as { error: string }
      expect(res.status).toBe(409)
      expect(body.error).toContain("status 'running'")
      expect(body.error).toContain('Kill the task first')
    })

    it('returns 409 when the original task is paused', async () => {
      const store = new TaskStore(db)
      const task = createTask({ name: 'Paused task' })
      store.update(task.id, { status: 'paused', resultStatus: 'question' })

      const res = await fetch(`${baseUrl}/api/tasks/${task.id}/restart`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })

      expect(res.status).toBe(409)
    })

    it('returns 400 when the body has invalid fields', async () => {
      const store = new TaskStore(db)
      const task = createTask({ name: 'Failed task' })
      store.update(task.id, {
        status: 'failed',
        resultStatus: 'failed',
        completedAt: '2026-03-27 10:00:00',
      })

      const badName = await fetch(`${baseUrl}/api/tasks/${task.id}/restart`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '   ' }),
      })
      expect(badName.status).toBe(400)

      const badDuration = await fetch(`${baseUrl}/api/tasks/${task.id}/restart`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxDurationMinutes: -5 }),
      })
      expect(badDuration.status).toBe(400)

      const badDurationZero = await fetch(`${baseUrl}/api/tasks/${task.id}/restart`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxDurationMinutes: 0 }),
      })
      expect(badDurationZero.status).toBe(400)
    })

    it('returns 503 when the task runtime is not available', async () => {
      // `createApp({ db })` in this test file does not inject a TaskRuntime,
      // so every valid restart attempt should land on 503. This also
      // exercises the guard path before the runner is touched.
      const store = new TaskStore(db)
      const task = createTask({ name: 'Completed task' })
      store.update(task.id, {
        status: 'completed',
        resultStatus: 'completed',
        completedAt: '2026-03-27 10:00:00',
      })

      const res = await fetch(`${baseUrl}/api/tasks/${task.id}/restart`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })

      const body = await res.json() as { error: string }
      expect(res.status).toBe(503)
      expect(body.error).toContain('runtime is not available')
    })
  })
})
