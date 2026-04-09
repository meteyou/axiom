import type { AgentTool } from '@mariozechner/pi-agent-core'
import { Type } from '@mariozechner/pi-ai'
import type { Database } from './database.js'

export interface ChatHistoryToolsOptions {
  db: Database
}

interface ChatMessageRow {
  id: number
  session_id: string
  user_id: number | null
  role: string
  content: string
  metadata: string | null
  timestamp: string
}

/**
 * Create the `read_chat_history` agent tool.
 *
 * Reads chat messages from the database with optional datetime and source filtering.
 * Useful for:
 * - Agent Heartbeat: reading recent conversations to extract memory-worthy facts
 * - User queries: "What did we talk about yesterday at 2pm?"
 * - Session review: browsing messages from a specific session
 */
export function createReadChatHistoryTool(options: ChatHistoryToolsOptions): AgentTool {
  return {
    name: 'read_chat_history',
    label: 'Read Chat History',
    description:
      'Read chat messages from the database. Supports filtering by datetime range, source (web/telegram/task), ' +
      'role (user/assistant/tool/system), and session. Returns messages in chronological order. ' +
      'Use this to review past conversations, extract facts for memory, or answer questions about chat history. ' +
      'Optionally search message content and related tool call inputs/outputs with the query parameter.',
    parameters: Type.Object({
      start: Type.Optional(
        Type.String({
          description:
            'Start datetime (inclusive) in ISO 8601 format, e.g. "2025-04-04T14:00:00" or "2025-04-04". ' +
            'Messages from this time onward are included. Omit to not filter by start time.',
        }),
      ),
      end: Type.Optional(
        Type.String({
          description:
            'End datetime (exclusive) in ISO 8601 format, e.g. "2025-04-04T15:00:00" or "2025-04-05". ' +
            'Messages before this time are included. Omit to not filter by end time.',
        }),
      ),
      source: Type.Optional(
        Type.String({
          description:
            'Filter by message source: "web", "telegram", or "task". Matches the session_id prefix. ' +
            'Omit to include all sources.',
        }),
      ),
      role: Type.Optional(
        Type.String({
          description:
            'Filter by message role: "user", "assistant", "tool", or "system". Omit to include all roles.',
        }),
      ),
      session_id: Type.Optional(
        Type.String({
          description: 'Filter by exact session ID. Omit to include all sessions.',
        }),
      ),
      limit: Type.Optional(
        Type.Number({
          description: 'Maximum number of messages to return (default: 100, max: 500).',
        }),
      ),
      offset: Type.Optional(
        Type.Number({
          description: 'Number of messages to skip for pagination (default: 0).',
        }),
      ),
      query: Type.Optional(
        Type.String({
          description:
            'Full-text search query. Filters messages where content contains this string (case-insensitive). ' +
            'Also searches tool call inputs and outputs associated with the same session. ' +
            'Omit to return all messages.',
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const {
        start,
        end,
        source,
        role,
        session_id,
        limit: rawLimit,
        offset: rawOffset,
        query,
      } = params as {
        start?: string
        end?: string
        source?: string
        role?: string
        session_id?: string
        limit?: number
        offset?: number
        query?: string
      }

      try {
        const limit = Math.min(Math.max(rawLimit ?? 100, 1), 500)
        const offset = Math.max(rawOffset ?? 0, 0)

        // Build query dynamically
        const conditions: string[] = []
        const queryParams: unknown[] = []

        // Datetime filters — normalize to SQLite-compatible format
        if (start) {
          const normalized = normalizeDatetime(start)
          if (!normalized) {
            return {
              content: [{ type: 'text' as const, text: `Error: Invalid start datetime "${start}". Use ISO 8601 format, e.g. "2025-04-04T14:00:00" or "2025-04-04".` }],
              details: { error: true },
            }
          }
          conditions.push('timestamp >= ?')
          queryParams.push(normalized)
        }

        if (end) {
          const normalized = normalizeDatetime(end)
          if (!normalized) {
            return {
              content: [{ type: 'text' as const, text: `Error: Invalid end datetime "${end}". Use ISO 8601 format, e.g. "2025-04-05T00:00:00" or "2025-04-05".` }],
              details: { error: true },
            }
          }
          conditions.push('timestamp < ?')
          queryParams.push(normalized)
        }

        // Source filter — matches session_id prefix pattern
        if (source) {
          const validSources = ['web', 'telegram', 'task']
          if (!validSources.includes(source)) {
            return {
              content: [{ type: 'text' as const, text: `Error: Invalid source "${source}". Valid sources: ${validSources.join(', ')}.` }],
              details: { error: true },
            }
          }
          if (source === 'task') {
            // Task sessions use various prefixes: "task-", "agent-heartbeat-", "task-injection-"
            conditions.push("(session_id LIKE 'task-%' OR session_id LIKE 'agent-heartbeat-%' OR session_id LIKE 'task-injection-%')")
          } else if (source === 'telegram') {
            conditions.push("session_id LIKE 'telegram-%'")
          } else {
            // Web sessions: "web-" prefix or "session-" (from SessionManager)
            conditions.push("(session_id LIKE 'web-%' OR session_id LIKE 'session-%')")
          }
        }

        // Role filter
        if (role) {
          const validRoles = ['user', 'assistant', 'tool', 'system']
          if (!validRoles.includes(role)) {
            return {
              content: [{ type: 'text' as const, text: `Error: Invalid role "${role}". Valid roles: ${validRoles.join(', ')}.` }],
              details: { error: true },
            }
          }
          conditions.push('role = ?')
          queryParams.push(role)
        }

        // Session ID filter
        if (session_id) {
          conditions.push('session_id = ?')
          queryParams.push(session_id)
        }

        // Full-text query filter: match content OR tool call input/output in same session
        if (query) {
          const pattern = `%${query}%`
          conditions.push(
            '(content LIKE ? OR id IN (' +
            '  SELECT cm.id FROM chat_messages cm' +
            '  INNER JOIN tool_calls tc ON tc.session_id = cm.session_id' +
            '  WHERE tc.input LIKE ? OR tc.output LIKE ?' +
            '))'
          )
          queryParams.push(pattern, pattern, pattern)
        }

        const whereClause = conditions.length > 0
          ? `WHERE ${conditions.join(' AND ')}`
          : ''

        // Get total count
        const countSql = `SELECT COUNT(*) as count FROM chat_messages ${whereClause}`
        const { count: total } = options.db.prepare(countSql).get(...queryParams) as { count: number }

        if (total === 0) {
          const filterDesc = buildFilterDescription({ start, end, source, role, session_id, query })
          return {
            content: [{ type: 'text' as const, text: `No chat messages found${filterDesc}.` }],
            details: { count: 0, total: 0, filters: { start, end, source, role, session_id, query } },
          }
        }

        // Fetch messages in chronological order
        const selectSql = `SELECT id, session_id, user_id, role, content, metadata, timestamp
          FROM chat_messages ${whereClause}
          ORDER BY timestamp ASC
          LIMIT ? OFFSET ?`
        queryParams.push(limit, offset)

        const rows = options.db.prepare(selectSql).all(...queryParams) as ChatMessageRow[]

        // Format messages for readability
        const formatted = rows.map(row => {
          const meta = parseMetadata(row.metadata)
          const sourceLabel = detectSource(row.session_id)
          const parts: string[] = [
            `[${row.timestamp}] [${sourceLabel}] [${row.role}]`,
          ]

          // Add username context if available from metadata
          if (meta?.username) {
            parts[0] = `[${row.timestamp}] [${sourceLabel}] [${row.role}: ${meta.username}]`
          }

          // Truncate very long messages to keep output manageable
          const maxContentLength = 2000
          const content = row.content.length > maxContentLength
            ? row.content.slice(0, maxContentLength) + `\n... (truncated, ${row.content.length} chars total)`
            : row.content

          parts.push(content)

          return parts.join('\n')
        })

        const output = formatted.join('\n\n---\n\n')
        const paginationInfo = total > limit + offset
          ? `\n\nShowing ${offset + 1}–${offset + rows.length} of ${total} messages. Use offset=${offset + limit} to see more.`
          : `\n\n${total} message(s) total.`

        return {
          content: [{ type: 'text' as const, text: output + paginationInfo }],
          details: {
            count: rows.length,
            total,
            offset,
            limit,
            filters: { start, end, source, role, session_id, query },
          },
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: 'text' as const, text: `Error reading chat history: ${errorMsg}` }],
          details: { error: true },
        }
      }
    },
  }
}

/**
 * Normalize a datetime string to SQLite-compatible format (YYYY-MM-DD HH:MM:SS).
 * 
 * The database stores timestamps in UTC via datetime('now').
 * - Date-only ("2025-04-04") → "2025-04-04 00:00:00" (treated as UTC)
 * - ISO without timezone ("2025-04-04T14:00:00") → "2025-04-04 14:00:00" (treated as UTC)
 * - ISO with timezone ("2025-04-04T14:00:00Z", "2025-04-04T14:00:00+02:00") → converted to UTC
 * 
 * Returns null if the input is invalid.
 */
function normalizeDatetime(input: string): string | null {
  // Date-only: "2025-04-04"
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    return `${input} 00:00:00`
  }

  // ISO without timezone: "2025-04-04T14:00:00" — treat as UTC, just reformat
  const noTzMatch = input.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})$/)
  if (noTzMatch) {
    return `${noTzMatch[1]} ${noTzMatch[2]}`
  }

  // ISO with timezone (Z or +/-offset): parse and convert to UTC
  const date = new Date(input)
  if (isNaN(date.getTime())) {
    return null
  }

  return date.toISOString().replace('T', ' ').slice(0, 19)
}

/**
 * Parse metadata JSON safely
 */
function parseMetadata(metadata: string | null): Record<string, unknown> | null {
  if (!metadata) return null
  try {
    return JSON.parse(metadata)
  } catch {
    return null
  }
}

/**
 * Detect the source of a message from its session_id prefix
 */
function detectSource(sessionId: string): string {
  if (sessionId.startsWith('web-') || sessionId.startsWith('session-')) return 'web'
  if (sessionId.startsWith('telegram-')) return 'telegram'
  if (sessionId.startsWith('task-') || sessionId.startsWith('agent-heartbeat-')) return 'task'
  if (sessionId.startsWith('task-injection-')) return 'task-injection'
  return 'unknown'
}

/**
 * Build a human-readable filter description for empty results
 */
function buildFilterDescription(filters: {
  start?: string
  end?: string
  source?: string
  role?: string
  session_id?: string
  query?: string
}): string {
  const parts: string[] = []
  if (filters.start) parts.push(`from ${filters.start}`)
  if (filters.end) parts.push(`until ${filters.end}`)
  if (filters.source) parts.push(`source: ${filters.source}`)
  if (filters.role) parts.push(`role: ${filters.role}`)
  if (filters.session_id) parts.push(`session: ${filters.session_id}`)
  if (filters.query) parts.push(`query: "${filters.query}"`)
  return parts.length > 0 ? ` (filters: ${parts.join(', ')})` : ''
}
