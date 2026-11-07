import type { Database } from './database.js'

export interface ConversationMessageRow {
  id: number
  session_id: string
  role: string
  content: string
  metadata: string | null
  timestamp: string
}

/**
 * Messages of a session and all its descendant sessions (tasks, loop
 * detection, ...) linked via `parent_session_id`, oldest first.
 * `order: 'id'` gives insertion order, which is what cursors rely on.
 */
export function loadSessionTreeMessages(
  db: Database,
  sessionId: string,
  order: 'timestamp' | 'id',
): ConversationMessageRow[] {
  const orderColumn = order === 'id' ? 'id' : 'timestamp'
  // UNION (distinct) keeps accidental cycles in parent_session_id from recursing forever.
  return db.prepare(
    `WITH RECURSIVE session_tree(id) AS (
       SELECT ?
       UNION
       SELECT s.id FROM sessions s
       JOIN session_tree st ON s.parent_session_id = st.id
     )
     SELECT id, session_id, role, content, metadata, timestamp
     FROM chat_messages
     WHERE session_id IN (SELECT id FROM session_tree)
     ORDER BY ${orderColumn} ASC`
  ).all(sessionId) as ConversationMessageRow[]
}

function parseMetadata(metadata: string | null): Record<string, unknown> | null {
  try {
    return metadata ? JSON.parse(metadata) as Record<string, unknown> : null
  } catch {
    return null
  }
}

/**
 * Render one chat message as a transcript line for summaries and fact
 * extraction, or null when the message is not part of the transcript
 * (tool rows, other system rows).
 */
export function formatConversationLine(message: Pick<ConversationMessageRow, 'role' | 'content' | 'metadata'>): string | null {
  const metadata = parseMetadata(message.metadata)

  if (message.role === 'user') {
    return `User: ${message.content}`
  }
  if (message.role === 'assistant') {
    return metadata?.type === 'task_injection_response'
      ? `Assistant (task update): ${message.content.slice(0, 2000)}`
      : `Assistant: ${message.content.slice(0, 2000)}`
  }
  if (message.role === 'system' && metadata?.type === 'task_result') {
    const taskStatus = typeof metadata.taskResultStatus === 'string'
      ? metadata.taskResultStatus
      : typeof metadata.taskStatus === 'string'
        ? metadata.taskStatus
        : 'completed'
    const taskName = typeof metadata.taskName === 'string' ? metadata.taskName.trim() : ''
    const taskLabel = taskName ? `: ${taskName}` : ''
    return `Background task (${taskStatus}${taskLabel}): ${message.content.slice(0, 2000)}`
  }
  if (message.role === 'system' && metadata?.type === 'reminder') {
    return `Reminder: ${message.content.slice(0, 2000)}`
  }
  return null
}
