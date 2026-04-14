import { beforeEach, describe, expect, it } from 'vitest'
import type { AgentTool } from '@mariozechner/pi-agent-core'
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

describe('search_memories tool', () => {
  let db: Database

  beforeEach(() => {
    db = initDatabase(':memory:')
    insertUser(db, 1, 'alice')
    insertUser(db, 2, 'bob')
  })

  it('creates a tool with correct metadata and schema', () => {
    const tool = createSearchMemoriesTool({ db })

    expect(tool.name).toBe('search_memories')
    expect(tool.label).toBe('Search Memories')
    expect(tool.description).toContain('fact memory')
    expect(tool.parameters.properties.query).toBeDefined()
    expect(tool.parameters.properties.limit).toBeDefined()
    expect(tool.parameters.required).toContain('query')
  })

  it('returns formatted results when called', async () => {
    createMemory(db, 1, 'session-a', 'Postgres runs on port 5432', 'extracted_fact')
    createMemory(db, 1, 'session-b', 'Redis runs on port 6379', 'extracted_fact')

    const tool = createSearchMemoriesTool({ db, getCurrentUserId: () => 1 })
    const result = await tool.execute('tool-call-1', { query: 'postgres port' })
    const text = getTextContent(result)
    const details = getDetails(result)

    expect(text).toContain('[extracted_fact]')
    expect(text).toContain('Session: session-a')
    expect(text).toContain('Postgres runs on port 5432')
    expect(details.count).toBe(1)
    expect(details.userId).toBe(1)
  })

  it('scopes search results to the current user when available', async () => {
    createMemory(db, 1, 'session-a', 'postgres port is 5432', 'session')
    createMemory(db, 2, 'session-b', 'postgres port is 6432', 'session')

    const tool = createSearchMemoriesTool({ db, getCurrentUserId: () => 2 })
    const result = await tool.execute('tool-call-2', { query: 'postgres' })
    const text = getTextContent(result)

    expect(text).toContain('6432')
    expect(text).not.toContain('5432')
  })

  it('handles empty results gracefully', async () => {
    const tool = createSearchMemoriesTool({ db, getCurrentUserId: () => 1 })
    const result = await tool.execute('tool-call-3', { query: 'no-match-xyz' })
    const text = getTextContent(result)
    const details = getDetails(result)

    expect(text).toContain('No memories found for query "no-match-xyz".')
    expect(details.count).toBe(0)
  })

  it('validates query and limit parameters', async () => {
    const tool = createSearchMemoriesTool({ db })

    const blankQueryResult = await tool.execute('tool-call-4', { query: '   ' })
    expect(getTextContent(blankQueryResult)).toContain('query must be a non-empty string')

    const invalidLimitResult = await tool.execute('tool-call-5', { query: 'postgres', limit: 0 })
    expect(getTextContent(invalidLimitResult)).toContain('limit must be a positive number')
  })

  it('caps limit at 50', async () => {
    for (let i = 0; i < 60; i++) {
      createMemory(db, 1, `session-${i}`, `postgres fact ${i}`, 'session')
    }

    const tool = createSearchMemoriesTool({ db, getCurrentUserId: () => 1 })
    const result = await tool.execute('tool-call-6', { query: 'postgres', limit: 100 })
    const details = getDetails(result)

    expect(details.limit).toBe(50)
    expect(details.count).toBe(50)
  })
})
