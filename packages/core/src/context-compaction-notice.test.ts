import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import { parseContextCompactionInfo } from './contracts/compaction.js'
import type { ContextCompactionInfo } from './contracts/compaction.js'
import { formatContextCompactionContent, saveContextCompactionNotice } from './context-compaction-notice.js'

const completed: ContextCompactionInfo = {
  compactionId: 'c-1',
  status: 'completed',
  reason: 'threshold',
  tokensBefore: 368_000,
  tokensAfter: 41_000,
  summary: '## Goal',
  warnings: ['auto_paused'],
  occurredAt: '2026-01-01T00:00:00.000Z',
}

describe('saveContextCompactionNotice', () => {
  let db: Database
  let dbPath: string

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `axiom-compaction-notice-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
    db = initDatabase(dbPath)
  })

  afterEach(() => {
    db.close()
    fs.rmSync(dbPath, { force: true })
  })

  it('stores a finished compaction as a system row that round-trips through the history parser', () => {
    const saved = saveContextCompactionNotice(db, { sessionId: 's-1', userId: null, info: completed })
    expect(saved.messageId).toBeTypeOf('number')

    const row = db.prepare('SELECT role, content, metadata FROM chat_messages WHERE id = ?').get(saved.messageId) as
      { role: string; content: string; metadata: string }
    expect(row.role).toBe('system')
    expect(row.content).toBe(formatContextCompactionContent(completed))
    expect(parseContextCompactionInfo(JSON.parse(row.metadata), saved.messageId)).toEqual(saved)
  })

  it('updates the row of a compaction in place when its measured size arrives', () => {
    const saved = saveContextCompactionNotice(db, { sessionId: 's-1', userId: null, info: completed })
    const measured = saveContextCompactionNotice(db, {
      sessionId: 's-1',
      userId: null,
      info: { ...completed, tokensAfter: 33_000, tokensAfterMeasured: true },
    })

    expect(measured.messageId).toBe(saved.messageId)
    const rows = db.prepare('SELECT content, metadata FROM chat_messages').all() as { content: string; metadata: string }[]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.content).toContain('368k \u2192 33k tokens')
    expect(parseContextCompactionInfo(JSON.parse(rows[0]!.metadata))).toMatchObject({ tokensAfter: 33_000, tokensAfterMeasured: true })
  })

  it('keeps running keepalives live-only', () => {
    const running = { ...completed, status: 'running' as const }
    expect(saveContextCompactionNotice(db, { sessionId: 's-1', userId: null, info: running })).toBe(running)
    expect((db.prepare('SELECT COUNT(*) AS count FROM chat_messages').get() as { count: number }).count).toBe(0)
  })
})

describe('formatContextCompactionContent', () => {
  it('adds one line per warning', () => {
    const lines = formatContextCompactionContent(completed).split('\n')
    expect(lines[0]).toContain('368k \u2192 ~41k')
    expect(lines[1]).toContain('Automatic compaction is paused')
  })
})
