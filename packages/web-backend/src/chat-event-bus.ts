import { EventEmitter } from 'node:events'
import type { UploadDescriptor } from '@axiom/core'

/**
 * A chat event emitted when messages flow through any channel (web, telegram).
 * Used to synchronize chat state across connected clients.
 */
export interface ChatEvent {
  /** The kind of event being broadcast */
  type: 'user_message' | 'text' | 'thinking' | 'tool_call_start' | 'tool_call_end' | 'done' | 'error' | 'system' | 'session_end' | 'task_completed' | 'task_failed' | 'task_question' | 'task_status_update' | 'reminder' | 'attachment'
  /** The Axiom user ID (integer) this event belongs to */
  userId: number
  /** Where the event originated */
  source: 'web' | 'telegram' | 'task'
  /** Opaque ID of the originating connection (to avoid echo) */
  sourceConnectionId?: string
  /** Chat session ID */
  sessionId?: string
  /** Text content (for user_message, text, system, error) */
  text?: string
  /** Thinking delta (for type='thinking') */
  thinking?: string
  /** Tool name (for tool_call_start, tool_call_end) */
  toolName?: string
  /** Tool call ID */
  toolCallId?: string
  /** Tool arguments */
  toolArgs?: unknown
  /** Tool result */
  toolResult?: unknown
  /** Whether the tool call errored */
  toolIsError?: boolean
  /** Error description */
  error?: string
  /** Display name of the sender (e.g. Telegram username) */
  senderName?: string
  /** Task ID (for task_completed, task_failed, task_question events) */
  taskId?: string
  /** Task name (for task events) */
  taskName?: string
  /** Task result summary (for task events) */
  taskSummary?: string
  /** Task duration in minutes (for task events) */
  taskDurationMinutes?: number
  /** Total tokens used by the task (for task events) */
  taskTokensUsed?: number
  /** Task trigger type (user, agent, cronjob) */
  taskTriggerType?: string
  /**
   * Human-readable single-line summary for `task_status_update` events
   * (also the value persisted in `chat_messages.content`). Live clients
   * render this verbatim so a page reload + live rendering match.
   */
  taskStatusContent?: string
  /** How long the task has been running, in minutes. */
  taskStatusRuntimeMinutes?: number
  /** Number of tool calls the task has made so far. */
  taskStatusToolCallCount?: number
  /** Approximate total tokens consumed by the task so far. */
  taskStatusTokensUsed?: number
  /** Reminder message (for reminder events) */
  reminderMessage?: string
  /** Reminder/cronjob name (for reminder events) */
  reminderName?: string
  /** Cronjob ID (for reminder events) */
  cronjobId?: string
  /** Whether this message was also delivered to Telegram */
  telegramDelivered?: boolean
  /** Whether this event is part of a task injection response */
  isTaskInjection?: boolean
  /** Uploaded file attached to the current assistant turn (for type='attachment') */
  attachment?: UploadDescriptor
  /**
   * Excerpt of the message the user replied to (e.g. in Telegram), truncated to 500 chars.
   * Forwarded to web clients so they can render a quote bubble above the user message.
   * Only set for `type: 'user_message'`.
   */
  replyContext?: string
}

/**
 * Simple event bus for broadcasting chat events across channels.
 * Both ws-chat and telegram emit into this bus; ws-chat subscribes
 * to forward events to the appropriate WebSocket clients.
 */
export class ChatEventBus extends EventEmitter {
  /**
   * Broadcast a chat event to all subscribers.
   */
  broadcast(msg: ChatEvent): void {
    super.emit('chat', msg)
  }

  /**
   * Subscribe to chat events. Returns an unsubscribe function.
   */
  subscribe(handler: (msg: ChatEvent) => void): () => void {
    super.on('chat', handler)
    return () => { super.off('chat', handler) }
  }
}
