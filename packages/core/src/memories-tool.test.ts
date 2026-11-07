import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import { createMemory } from './memories-store.js'
import { createSearchMemoriesTool } from './memories-tool.js'

function insertUser(db: Database, id: number, username: string): void {
  db.prepare(
    'INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)',
  ).run(id, username, 'hash', 'user')
}

function getTextContent(result: Awaited<ReturnType<AgentTool['execute']>>): string {
  if (!result || !('content' in result)) return ''
  const content = (result as { content: { type: string; text?: string }[] }).content
  return content.filter(item => item.type === 'text').map(item => item.text ?? '').join('')
}

function getDetails(result: Awaited<ReturnType<AgentTool['execute']>>): Record<string, unknown> {
  if (!result || !('details' in result)) return {}
  return (result as { details: Record<string, unknown> }).details
}

describe('memory_search tool', () => {
  let db: Database
  let memoryDir: string

  beforeEach(() => {
    db = initDatabase(':memory:')
    insertUser(db, 1, 'alice')
    insertUser(db, 2, 'bob')
    memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-memory-search-'))
    fs.mkdirSync(path.join(memoryDir, 'wiki'))
  })

  afterEach(() => {
    db.close()
    fs.rmSync(memoryDir, { recursive: true, force: true })
  })

  it('creates a tool with correct metadata and schema', () => {
    const tool = createSearchMemoriesTool({ db, memoryDir })

    expect(tool.name).toBe('memory_search')
    expect(tool.label).toBe('Search Memories')
    expect(tool.description).toContain('fact memory')
    expect(tool.description).toContain('wiki')
    expect(tool.description).toContain('file_read')
    const schema = tool.parameters as { properties: Record<string, unknown>; required?: string[] }
    expect(schema.properties.query).toBeDefined()
    expect(schema.properties.limit).toBeDefined()
    expect(schema.required).toContain('query')
  })

  it('returns formatted results when called', async () => {
    createMemory(db, 1, 'session-a', 'Postgres runs on port 5432', 'extracted_fact')
    createMemory(db, 1, 'session-b', 'Redis runs on port 6379', 'extracted_fact')

    const tool = createSearchMemoriesTool({ db, memoryDir, getCurrentUserId: () => 1 })
    const result = await tool.execute('tool-call-1', { query: 'postgres port' })
    const text = getTextContent(result)
    const details = getDetails(result)

    expect(text).toContain('[extracted_fact]')
    expect(text).toContain('Session: session-a')
    expect(text).toContain('Postgres runs on port 5432')
    // OR semantics: 'port' also matches the Redis fact, but Postgres ranks first
    expect(details.count).toBe(2)
    expect(text.indexOf('Postgres')).toBeLessThan(text.indexOf('Redis'))
    expect(details.userId).toBe(1)
  })

  it('scopes search results to the current user when available', async () => {
    createMemory(db, 1, 'session-a', 'postgres port is 5432', 'session')
    createMemory(db, 2, 'session-b', 'postgres port is 6432', 'session')

    const tool = createSearchMemoriesTool({ db, memoryDir, getCurrentUserId: () => 2 })
    const result = await tool.execute('tool-call-2', { query: 'postgres' })
    const text = getTextContent(result)

    expect(text).toContain('6432')
    expect(text).not.toContain('5432')
  })

  it('handles empty results gracefully', async () => {
    const tool = createSearchMemoriesTool({ db, memoryDir, getCurrentUserId: () => 1 })
    const result = await tool.execute('tool-call-3', { query: 'no-match-xyz' })
    const text = getTextContent(result)
    const details = getDetails(result)

    expect(text).toContain('## Facts\n\nNo matching facts.')
    expect(text).toContain('## Wiki\n\nNo matching wiki pages.')
    expect(details.count).toBe(0)
    expect(details.wikiCount).toBe(0)
  })

  it('returns a facts group and a wiki group with path, title, aliases and snippet', async () => {
    createMemory(db, 1, 'session-a', 'Postgres runs on port 5432', 'extracted_fact')
    const wikiPage = path.join(memoryDir, 'wiki', 'database.md')
    fs.writeFileSync(wikiPage, '---\naliases: [db, pg]\n---\n# Database Setup\n\nPostgres is backed up nightly.\n')

    const tool = createSearchMemoriesTool({ db, memoryDir, getCurrentUserId: () => 1 })
    const result = await tool.execute('tool-call-7', { query: 'postgres' })
    const text = getTextContent(result)
    const details = getDetails(result)

    expect(text.indexOf('## Facts')).toBeLessThan(text.indexOf('Postgres runs on port 5432'))
    expect(text.indexOf('## Wiki')).toBeGreaterThan(text.indexOf('Postgres runs on port 5432'))
    expect(text).toContain('1. Database Setup')
    expect(text).toContain(`Path: ${wikiPage}`)
    expect(text).toContain('Aliases: db, pg')
    expect(text).toContain('**Postgres** is backed up nightly.')
    expect(details.count).toBe(1)
    expect(details.wikiCount).toBe(1)
  })

  it('validates query and limit parameters', async () => {
    const tool = createSearchMemoriesTool({ db, memoryDir })

    const blankQueryResult = await tool.execute('tool-call-4', { query: '   ' })
    expect(getTextContent(blankQueryResult)).toContain('query must be a non-empty string')

    const invalidLimitResult = await tool.execute('tool-call-5', { query: 'postgres', limit: 0 })
    expect(getTextContent(invalidLimitResult)).toContain('limit must be a positive number')
  })

  it('caps limit at 50', async () => {
    for (let i = 0; i < 60; i++) {
      createMemory(db, 1, `session-${i}`, `postgres fact ${i}`, 'session')
    }

    const tool = createSearchMemoriesTool({ db, memoryDir, getCurrentUserId: () => 1 })
    const result = await tool.execute('tool-call-6', { query: 'postgres', limit: 100 })
    const details = getDetails(result)

    expect(details.limit).toBe(50)
    expect(details.count).toBe(50)
  })
})
