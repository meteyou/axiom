import type { Database } from './database.js'
import type { Task } from './task-store.js'

/**
 * Status emoji for task result formatting
 */
function statusEmoji(status: string): string {
  switch (status) {
    case 'completed': return '✅'
    case 'failed': return '❌'
    case 'question': return '❓'
    default: return 'ℹ️'
  }
}

/**
 * Format a task result for Telegram notification
 */
export function formatTaskTelegramMessage(task: Task, durationMinutes: number): string {
  const emoji = statusEmoji(task.resultStatus ?? task.status)
  const totalTokens = task.promptTokens + task.completionTokens
  const statusLabel = task.resultStatus ?? task.status

  const lines: string[] = [
    `${emoji} <b>Task ${statusLabel}: ${escapeHtml(task.name)}</b>`,
    '',
  ]

  if (task.resultSummary) {
    lines.push(escapeHtml(task.resultSummary))
    lines.push('')
  } else if (task.errorMessage) {
    lines.push(escapeHtml(task.errorMessage))
    lines.push('')
  }

  const details: string[] = []
  if (durationMinutes > 0) {
    details.push(`⏱ ${durationMinutes}min`)
  }
  if (totalTokens > 0) {
    details.push(`🔤 ${formatTokenCount(totalTokens)} tokens`)
  }
  if (details.length > 0) {
    lines.push(details.join('  •  '))
  }

  return lines.join('\n')
}

/**
 * Format token count for display (e.g., 12345 -> "12.3k")
 */
function formatTokenCount(count: number): string {
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}k`
  }
  return String(count)
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * Resolve the session ID under which a task result notification should be
 * persisted. Walks the task's session lineage:
 *
 * - If the task's session has a `parent_session_id`, use the parent
 *   (typically the user's interactive session that triggered the task).
 * - Otherwise fall back to the task's own session (cronjob, heartbeat,
 *   consolidation — background tasks without an interactive trigger).
 *
 * This replaces the legacy `task-result-<taskId>` pseudo-session ID.
 */
export function resolveTaskNotificationSessionId(db: Database, task: Task): string {
  if (!task.sessionId) {
    // Should not happen for tasks created via TaskRunner, but degrade
    // gracefully rather than throwing.
    return `task-result-${task.id}`
  }

  const row = db.prepare(
    'SELECT parent_session_id FROM sessions WHERE id = ?'
  ).get(task.sessionId) as { parent_session_id: string | null } | undefined

  return row?.parent_session_id ?? task.sessionId
}

/**
 * Persist a task result to the chat_messages table so it appears in web chat history.
 *
 * When `sessionId` is not provided, the target session is resolved via
 * `resolveTaskNotificationSessionId` (parent interactive session, or the
 * task's own session as fallback).
 */
export function persistTaskResultMessage(
  db: Database,
  userId: number,
  task: Task,
  durationMinutes: number,
  sessionId?: string,
): void {
  const emoji = statusEmoji(task.resultStatus ?? task.status)
  const statusLabel = task.resultStatus ?? task.status
  const content = `${emoji} Task ${statusLabel}: ${task.name}\n\n${task.resultSummary ?? task.errorMessage ?? 'No summary available.'}`

  const metadata = JSON.stringify({
    type: 'task_result',
    taskId: task.id,
    taskName: task.name,
    taskStatus: task.status,
    taskResultStatus: task.resultStatus,
    triggerType: task.triggerType,
    durationMinutes,
    promptTokens: task.promptTokens,
    completionTokens: task.completionTokens,
    estimatedCost: task.estimatedCost,
    toolCallCount: task.toolCallCount,
  })

  const resolvedSessionId = sessionId ?? resolveTaskNotificationSessionId(db, task)

  db.prepare(
    'INSERT INTO chat_messages (session_id, user_id, role, content, metadata) VALUES (?, ?, ?, ?, ?)'
  ).run(resolvedSessionId, userId, 'system', content, metadata)
}

export type TelegramDeliveryMode = 'auto' | 'always'

export interface TaskNotificationOptions {
  db: Database
  /** The user ID (OpenAgent numeric ID) this notification is for */
  userId: number
  /** The completed/failed/paused task */
  task: Task
  /** Duration in minutes */
  durationMinutes: number
  /** Telegram delivery mode from settings */
  telegramDeliveryMode: TelegramDeliveryMode
  /** Check if user has active WebSocket connection */
  hasActiveWebSocket: (userId: number) => boolean
  /** Send Telegram message. Returns true on success. */
  sendTelegram?: (message: string) => Promise<boolean>
  /** Broadcast a task event to all connected web clients */
  broadcastEvent?: (event: TaskNotificationEvent) => void
  /**
   * Optional pre-resolved target session ID for the persisted chat_messages
   * row. When omitted, it is resolved via `resolveTaskNotificationSessionId`.
   */
  targetSessionId?: string
}

export interface TaskNotificationEvent {
  type: 'task_completed' | 'task_failed' | 'task_question'
  userId: number
  taskId: string
  taskName: string
  taskSummary: string
  taskDurationMinutes: number
  taskTokensUsed: number
  taskTriggerType: string
}

/**
 * Deliver a task result notification:
 * 1. Always persist to chat_messages
 * 2. Broadcast via ChatEventBus for connected web clients
 * 3. Conditionally send Telegram notification
 */
export async function deliverTaskNotification(options: TaskNotificationOptions): Promise<{
  persisted: boolean
  telegramSent: boolean
  broadcastSent: boolean
}> {
  const {
    db,
    userId,
    task,
    durationMinutes,
    telegramDeliveryMode,
    hasActiveWebSocket,
    sendTelegram,
    broadcastEvent,
  } = options

  // 1. Always persist to chat_messages (under the resolved interactive
  // session via parent_session_id, or the task session as fallback).
  let persisted = false
  try {
    persistTaskResultMessage(db, userId, task, durationMinutes, options.targetSessionId)
    persisted = true
  } catch (err) {
    console.error(`[task-notification] Failed to persist task result for task ${task.id}:`, err)
  }

  // 2. Broadcast via ChatEventBus
  let broadcastSent = false
  if (broadcastEvent) {
    const eventType = task.resultStatus === 'question'
      ? 'task_question'
      : task.resultStatus === 'failed' || task.status === 'failed'
        ? 'task_failed'
        : 'task_completed'

    try {
      broadcastEvent({
        type: eventType,
        userId,
        taskId: task.id,
        taskName: task.name,
        taskSummary: task.resultSummary ?? task.errorMessage ?? 'No summary available.',
        taskDurationMinutes: durationMinutes,
        taskTokensUsed: task.promptTokens + task.completionTokens,
        taskTriggerType: task.triggerType,
      })
      broadcastSent = true
    } catch (err) {
      console.error(`[task-notification] Failed to broadcast task event for task ${task.id}:`, err)
    }
  }

  // 3. Conditionally send Telegram
  let telegramSent = false
  if (sendTelegram) {
    const shouldSendTelegram =
      telegramDeliveryMode === 'always' ||
      (telegramDeliveryMode === 'auto' && !hasActiveWebSocket(userId))

    if (shouldSendTelegram) {
      try {
        const message = formatTaskTelegramMessage(task, durationMinutes)
        telegramSent = await sendTelegram(message)
      } catch (err) {
        console.error(`[task-notification] Failed to send Telegram notification for task ${task.id}:`, err)
      }
    }
  }

  return { persisted, telegramSent, broadcastSent }
}
