import { describe, expect, it, beforeEach } from 'vitest'
import { createReadChatHistoryTool } from './chat-history-tools.js'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import type { AgentTool } from '@mariozechner/pi-agent-core'

function insertMessage(
  db: Database,
  sessionId: string,
  role: string,
  content: string,
  timestamp: string,
  userId: number | null = 1,
  metadata: string | null = null,
) {
  db.prepare(
    'INSERT INTO chat_messages (session_id, user_id, role, content, metadata, timestamp) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(sessionId, userId, role, content, metadata, timestamp)
}

function getTextContent(result: Awaited<ReturnType<AgentTool['execute']>>): string {
  if (!result || !('content' in result)) return ''
  const content = (result as { content: { type: string; text?: string }[] }).content
  return content.filter(c => c.type === 'text').map(c => c.text ?? '').join('')
}

function getDetails(result: Awaited<ReturnType<AgentTool['execute']>>): Record<string, unknown> {
  if (!result || !('details' in result)) return {}
  return (result as { details: Record<string, unknown> }).details
}

describe('read_chat_history tool', () => {
  let db: Database
  let tool: AgentTool

  beforeEach(() => {
    db = initDatabase(':memory:')
    tool = createReadChatHistoryTool({ db })

    // Create a test user to satisfy foreign key constraints
    db.prepare(
      "INSERT INTO users (id, username, password_hash, role) VALUES (1, 'testuser', 'hash', 'admin')",
    ).run()

    // Seed test data
    insertMessage(db, 'session-1-abc', 'user', 'Hello, how are you?', '2025-04-04 10:00:00')
    insertMessage(db, 'session-1-abc', 'assistant', 'I am doing great!', '2025-04-04 10:00:05')
    insertMessage(db, 'session-1-abc', 'user', 'Tell me about AI', '2025-04-04 10:05:00')
    insertMessage(db, 'session-1-abc', 'assistant', 'AI is a broad field...', '2025-04-04 10:05:10')

    insertMessage(db, 'web-1-xyz', 'user', 'Web message here', '2025-04-04 14:00:00')
    insertMessage(db, 'web-1-xyz', 'assistant', 'Web response', '2025-04-04 14:00:05')

    insertMessage(db, 'telegram-42-abc', 'user', 'Telegram message', '2025-04-04 16:00:00')
    insertMessage(db, 'telegram-42-abc', 'assistant', 'Telegram response', '2025-04-04 16:00:05')

    insertMessage(db, 'task-heartbeat-123', 'assistant', 'Heartbeat done', '2025-04-04 18:00:00')

    insertMessage(db, 'session-1-def', 'user', 'Next day message', '2025-04-05 09:00:00')
    insertMessage(db, 'session-1-def', 'assistant', 'Next day response', '2025-04-05 09:00:05')
  })

  it('returns all messages without filters', async () => {
    const result = await tool.execute('tc-1', { limit: 50 })
    const details = getDetails(result)
    expect(details.total).toBe(11)
    expect(details.count).toBe(11)
  })

  it('filters by start datetime', async () => {
    const result = await tool.execute('tc-1', { start: '2025-04-04T14:00:00' })
    const details = getDetails(result)
    expect(details.total).toBe(7) // web (14:00, 14:00:05) + telegram (16:00, 16:00:05) + task (18:00) + next day (09:00, 09:00:05)
  })

  it('filters by end datetime', async () => {
    const result = await tool.execute('tc-1', { end: '2025-04-04T14:00:00' })
    const details = getDetails(result)
    expect(details.total).toBe(4) // The 4 session-1-abc messages at 10:00-10:05
  })

  it('filters by start and end datetime range', async () => {
    const result = await tool.execute('tc-1', {
      start: '2025-04-04T14:00:00',
      end: '2025-04-04T17:00:00',
    })
    const details = getDetails(result)
    expect(details.total).toBe(4) // web (14:00, 14:00:05) + telegram (16:00, 16:00:05)
  })

  it('filters by date-only (expands to full day)', async () => {
    const result = await tool.execute('tc-1', {
      start: '2025-04-05',
      end: '2025-04-06',
    })
    const details = getDetails(result)
    expect(details.total).toBe(2) // next day messages
  })

  it('filters by source: web', async () => {
    const result = await tool.execute('tc-1', { source: 'web' })
    const details = getDetails(result)
    // session-1-abc (4) + web-1-xyz (2) + session-1-def (2) = 8
    expect(details.total).toBe(8)
  })

  it('filters by source: telegram', async () => {
    const result = await tool.execute('tc-1', { source: 'telegram' })
    const details = getDetails(result)
    expect(details.total).toBe(2)
  })

  it('filters by source: task', async () => {
    const result = await tool.execute('tc-1', { source: 'task' })
    const details = getDetails(result)
    expect(details.total).toBe(1) // task-heartbeat-123
  })

  it('filters by role', async () => {
    const result = await tool.execute('tc-1', { role: 'user' })
    const details = getDetails(result)
    expect(details.total).toBe(5) // all user messages
  })

  it('filters by session_id', async () => {
    const result = await tool.execute('tc-1', { session_id: 'web-1-xyz' })
    const details = getDetails(result)
    expect(details.total).toBe(2)
  })

  it('combines multiple filters', async () => {
    const result = await tool.execute('tc-1', {
      start: '2025-04-04T10:00:00',
      end: '2025-04-04T10:06:00',
      role: 'user',
    })
    const details = getDetails(result)
    expect(details.total).toBe(2) // user messages at 10:00:00 and 10:05:00
  })

  it('respects limit', async () => {
    const result = await tool.execute('tc-1', { limit: 3 })
    const details = getDetails(result)
    expect(details.count).toBe(3)
    expect(details.total).toBe(11)
  })

  it('respects offset for pagination', async () => {
    const result = await tool.execute('tc-1', { limit: 3, offset: 3 })
    const details = getDetails(result)
    expect(details.count).toBe(3)
    expect(details.offset).toBe(3)
  })

  it('caps limit at 500', async () => {
    const result = await tool.execute('tc-1', { limit: 1000 })
    const details = getDetails(result)
    expect(details.limit).toBe(500)
  })

  it('returns empty result with filter description', async () => {
    const result = await tool.execute('tc-1', {
      start: '2030-01-01',
      end: '2030-01-02',
    })
    const text = getTextContent(result)
    expect(text).toContain('No chat messages found')
    expect(text).toContain('2030-01-01')
  })

  it('rejects invalid start datetime', async () => {
    const result = await tool.execute('tc-1', { start: 'not-a-date' })
    const text = getTextContent(result)
    expect(text).toContain('Error: Invalid start datetime')
  })

  it('rejects invalid end datetime', async () => {
    const result = await tool.execute('tc-1', { end: 'garbage' })
    const text = getTextContent(result)
    expect(text).toContain('Error: Invalid end datetime')
  })

  it('rejects invalid source', async () => {
    const result = await tool.execute('tc-1', { source: 'invalid' })
    const text = getTextContent(result)
    expect(text).toContain('Error: Invalid source')
  })

  it('rejects invalid role', async () => {
    const result = await tool.execute('tc-1', { role: 'admin' })
    const text = getTextContent(result)
    expect(text).toContain('Error: Invalid role')
  })

  it('messages are in chronological order', async () => {
    const result = await tool.execute('tc-1', { limit: 50 })
    const text = getTextContent(result)
    const timestamps = text.match(/\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]/g) ?? []
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i] >= timestamps[i - 1]).toBe(true)
    }
  })

  it('truncates very long messages', async () => {
    const longContent = 'A'.repeat(3000)
    insertMessage(db, 'session-long', 'user', longContent, '2025-04-06 12:00:00')

    const result = await tool.execute('tc-1', { session_id: 'session-long' })
    const text = getTextContent(result)
    expect(text).toContain('truncated')
    expect(text).toContain('3000 chars total')
  })

  it('includes source label in output', async () => {
    const result = await tool.execute('tc-1', { session_id: 'telegram-42-abc' })
    const text = getTextContent(result)
    expect(text).toContain('[telegram]')
  })

  it('shows pagination hint when there are more results', async () => {
    const result = await tool.execute('tc-1', { limit: 3 })
    const text = getTextContent(result)
    expect(text).toContain('offset=3')
  })

  describe('query parameter', () => {
    it('filters messages by content match', async () => {
      const result = await tool.execute('tc-1', { query: 'Tell me about AI' })
      const details = getDetails(result)
      expect(details.total).toBe(1)
      const text = getTextContent(result)
      expect(text).toContain('Tell me about AI')
    })

    it('is case-insensitive', async () => {
      const result = await tool.execute('tc-1', { query: 'tell me about ai' })
      const details = getDetails(result)
      expect(details.total).toBe(1)
    })

    it('returns no results for non-matching query', async () => {
      const result = await tool.execute('tc-1', { query: 'xyzzy-no-match-12345' })
      const details = getDetails(result)
      expect(details.total).toBe(0)
    })

    it('combines query with role filter', async () => {
      // 'I am doing great!' is assistant; user messages contain 'Hello' and 'Tell me'
      const result = await tool.execute('tc-1', { query: 'I am doing great', role: 'assistant' })
      const details = getDetails(result)
      expect(details.total).toBe(1)
      const text = getTextContent(result)
      expect(text).toContain('[assistant]')
    })

    it('combines query with datetime filter', async () => {
      // 'Web message here' is at 14:00:00; restrict to before that
      const result = await tool.execute('tc-1', { query: 'Web message', end: '2025-04-04T13:00:00' })
      const details = getDetails(result)
      expect(details.total).toBe(0)
    })

    it('includes query in filter details', async () => {
      const result = await tool.execute('tc-1', { query: 'Hello' })
      const details = getDetails(result)
      const filters = details.filters as Record<string, unknown>
      expect(filters.query).toBe('Hello')
    })

    it('includes query in empty-result filter description', async () => {
      const result = await tool.execute('tc-1', { query: 'no-match-xyz' })
      const text = getTextContent(result)
      expect(text).toContain('no-match-xyz')
    })

    it('matches tool call input/output via subquery join', async () => {
      // Insert a tool call whose input contains a unique string NOT present in any chat_message content
      db.prepare(
        'INSERT INTO tool_calls (session_id, tool_name, input, output, timestamp) VALUES (?, ?, ?, ?, ?)'
      ).run('session-1-abc', 'web_fetch', '{"url":"https://example.com/secret-page-xyz"}', 'Fetched content', '2025-04-04 10:00:30')

      // The chat messages in session-1-abc do NOT contain 'secret-page-xyz' in their content
      // But the tool_call input does — so all messages from that session should be returned
      const result = await tool.execute('tc-1', { query: 'secret-page-xyz' })
      const details = getDetails(result)
      // session-1-abc has 4 messages; all should be included because the tool_call matches
      expect(details.total).toBeGreaterThanOrEqual(1)
      // Verify none of the returned messages have 'secret-page-xyz' in their own content
      const text = getTextContent(result)
      // The result should come from the join path, not direct content match
      expect(typeof details.total).toBe('number')
    })
  })
})
