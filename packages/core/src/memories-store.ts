import type { Database } from './database.js'
import { normalizeFtsQuery } from './fts-utils.js'
import { NotFoundError, InvalidInputError } from './errors.js'

export interface MemoryFact {
  id: number
  userId: number | null
  sessionId: string | null
  content: string
  source: string
  timestamp: string
}

export interface SearchMemoriesOptions {
  userId?: number
  limit?: number
  dateFrom?: string
  dateTo?: string
}

export interface ListMemoriesOptions {
  userId?: number
  query?: string
  limit?: number
  offset?: number
  dateFrom?: string
  dateTo?: string
}

interface MemoryRow {
  id: number
  user_id: number | null
  session_id: string | null
  content: string
  source: string
  timestamp: string
}

function rowToMemoryFact(row: MemoryRow): MemoryFact {
  return {
    id: row.id,
    userId: row.user_id,
    sessionId: row.session_id,
    content: row.content,
    source: row.source,
    timestamp: row.timestamp,
  }
}

function normalizeDateFrom(input: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    return `${input} 00:00:00`
  }

  const noTzMatch = input.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})$/)
  if (noTzMatch) {
    return `${noTzMatch[1]} ${noTzMatch[2]}`
  }

  const date = new Date(input)
  if (isNaN(date.getTime())) {
    throw new InvalidInputError(`Invalid dateFrom value: ${input}`)
  }

  return date.toISOString().replace('T', ' ').slice(0, 19)
}

function normalizeDateTo(input: string): string {
  const dateOnlyMatch = input.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (dateOnlyMatch) {
    const nextDay = new Date(Date.UTC(
      Number.parseInt(dateOnlyMatch[1], 10),
      Number.parseInt(dateOnlyMatch[2], 10) - 1,
      Number.parseInt(dateOnlyMatch[3], 10) + 1,
    ))
    return nextDay.toISOString().replace('T', ' ').slice(0, 19)
  }

  const noTzMatch = input.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})$/)
  if (noTzMatch) {
    return `${noTzMatch[1]} ${noTzMatch[2]}`
  }

  const date = new Date(input)
  if (isNaN(date.getTime())) {
    throw new InvalidInputError(`Invalid dateTo value: ${input}`)
  }

  return date.toISOString().replace('T', ' ').slice(0, 19)
}

function buildMemoryFilters(
  options: Pick<SearchMemoriesOptions, 'userId' | 'dateFrom' | 'dateTo'>,
  alias: string,
): { conditions: string[]; params: unknown[] } {
  const conditions: string[] = []
  const params: unknown[] = []

  if (options.userId !== undefined) {
    conditions.push(`${alias}.user_id = ?`)
    params.push(options.userId)
  }

  if (options.dateFrom) {
    conditions.push(`${alias}.timestamp >= ?`)
    params.push(normalizeDateFrom(options.dateFrom))
  }

  if (options.dateTo) {
    conditions.push(`${alias}.timestamp < ?`)
    params.push(normalizeDateTo(options.dateTo))
  }

  return { conditions, params }
}

export function searchMemories(db: Database, query: string, options: SearchMemoriesOptions = {}): MemoryFact[] {
  const trimmedQuery = query.trim()
  if (trimmedQuery.length === 0) {
    return []
  }

  const limit = Math.max(1, Math.floor(options.limit ?? 10))
  const ftsQuery = normalizeFtsQuery(trimmedQuery)
  const { conditions, params } = buildMemoryFilters(options, 'm')
  const whereClause = conditions.length > 0 ? ` AND ${conditions.join(' AND ')}` : ''

  const sql = `
    SELECT m.id, m.user_id, m.session_id, m.content, m.source, m.timestamp
    FROM memories_fts
    INNER JOIN memories m ON m.id = memories_fts.rowid
    WHERE memories_fts MATCH ?${whereClause}
    ORDER BY bm25(memories_fts) ASC, m.timestamp DESC, m.id DESC
    LIMIT ?
  `

  const rows = db.prepare(sql).all(ftsQuery, ...params, limit) as MemoryRow[]
  return rows.map(rowToMemoryFact)
}

export function listMemories(db: Database, options: ListMemoriesOptions = {}): { facts: MemoryFact[]; total: number } {
  const limit = Math.max(1, Math.floor(options.limit ?? 50))
  const offset = Math.max(0, Math.floor(options.offset ?? 0))
  const trimmedQuery = options.query?.trim()
  const { conditions, params } = buildMemoryFilters(options, 'm')

  if (trimmedQuery) {
    const ftsQuery = normalizeFtsQuery(trimmedQuery)
    const whereClause = conditions.length > 0 ? ` AND ${conditions.join(' AND ')}` : ''

    const countSql = `
      SELECT COUNT(*) as count
      FROM memories m
      WHERE m.id IN (
        SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?
      )${whereClause}
    `

    const { count } = db.prepare(countSql).get(ftsQuery, ...params) as { count: number }

    const selectSql = `
      SELECT m.id, m.user_id, m.session_id, m.content, m.source, m.timestamp
      FROM memories_fts
      INNER JOIN memories m ON m.id = memories_fts.rowid
      WHERE memories_fts MATCH ?${whereClause}
      ORDER BY bm25(memories_fts) ASC, m.timestamp DESC, m.id DESC
      LIMIT ? OFFSET ?
    `

    const rows = db.prepare(selectSql).all(ftsQuery, ...params, limit, offset) as MemoryRow[]
    return { facts: rows.map(rowToMemoryFact), total: count }
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const countSql = `SELECT COUNT(*) as count FROM memories m ${whereClause}`
  const { count } = db.prepare(countSql).get(...params) as { count: number }

  const selectSql = `
    SELECT m.id, m.user_id, m.session_id, m.content, m.source, m.timestamp
    FROM memories m
    ${whereClause}
    ORDER BY m.timestamp DESC, m.id DESC
    LIMIT ? OFFSET ?
  `

  const rows = db.prepare(selectSql).all(...params, limit, offset) as MemoryRow[]
  return { facts: rows.map(rowToMemoryFact), total: count }
}

export function getMemoryById(db: Database, id: number): MemoryFact | null {
  const row = db.prepare(
    'SELECT id, user_id, session_id, content, source, timestamp FROM memories WHERE id = ?'
  ).get(id) as MemoryRow | undefined

  return row ? rowToMemoryFact(row) : null
}

export function createMemory(
  db: Database,
  userId: number | null,
  sessionId: string | null,
  content: string,
  source: string = 'session',
): number {
  const result = db.prepare(
    'INSERT INTO memories (user_id, session_id, content, source) VALUES (?, ?, ?, ?)'
  ).run(userId, sessionId, content, source)

  return Number(result.lastInsertRowid)
}

export function updateMemory(db: Database, id: number, content: string): void {
  const result = db.prepare('UPDATE memories SET content = ? WHERE id = ?').run(content, id)
  if (result.changes === 0) {
    throw new NotFoundError(`Memory not found: ${id}`)
  }
}

export function deleteMemory(db: Database, id: number): void {
  const result = db.prepare('DELETE FROM memories WHERE id = ?').run(id)
  if (result.changes === 0) {
    throw new NotFoundError(`Memory not found: ${id}`)
  }
}
