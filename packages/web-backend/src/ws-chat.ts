import { WebSocketServer, WebSocket } from 'ws'
import type { Server } from 'node:http'
import type {
  Database,
  UploadDescriptor,
  SlashCommandRegistry,
  SlashCommandPicker,
} from '@axiom/core'
import { isSlashCommandPicker } from '@axiom/core'
import type { AgentCore, ResponseChunk, RetryInfo, StallInfo, TurnErrorInfo, TurnEvent } from '@axiom/core'
import {
  TaskStore,
  ScheduledTaskStore,
  TurnRunner,
} from '@axiom/core'
import { buildWebChatSlashCommandRegistry } from './slash-commands.js'
import { verifyToken } from './auth.js'
import type { JwtPayload } from './auth.js'
import { URL } from 'node:url'
import crypto from 'node:crypto'
import type { RuntimeMetrics } from './runtime-metrics.js'
import type { ChatEventBus, ChatEvent } from './chat-event-bus.js'
import type { ChatActionMessage, ChatActionRegistry } from './chat-actions.js'
import { registerTurnRetryChatChannel } from './turn-retry-chat.js'
import type { TurnRetryChatChannel } from './turn-retry-chat.js'

interface ChatMessage {
  type: 'message' | 'command' | 'ping'
  content: string
  /** When true, skip saving to DB (message already persisted via HTTP upload) */
  skipSave?: boolean
  /** Upload descriptors for file attachments (passed when skipSave is true) */
  attachments?: UploadDescriptor[]
}

interface ChatResponse {
  type: 'text' | 'thinking' | 'tool_call_start' | 'tool_call_end' | 'error' | 'done' | 'system' | 'external_user_message' | 'session_end' | 'session_summary' | 'task_completed' | 'task_failed' | 'task_question' | 'task_status_update' | 'reminder' | 'pong' | 'attachment' | 'chat_action' | 'chat_action_resolved' | 'turn_replay_start' | 'turn_replay_end' | 'stall_warning' | 'stall_resolved' | 'retry_scheduled'
  text?: string
  /**
   * Auto-retry details (for `retry_scheduled`). Live-only status: the failed
   * attempt is discarded, so nothing about it is persisted.
   */
  retry?: RetryInfo
  /**
   * Provider-stall details (for `stall_warning` / `stall_resolved`). Carries
   * the `chat_messages` row id of the persisted notice so the client updates
   * the existing bubble in place instead of appending a second one.
   */
  stall?: StallInfo
  /**
   * Terminal-error details (for `error`). Present whenever the failure was
   * persisted as a chat row: it carries that row's id plus the machine-readable
   * cause, so the client renders the same error bubble live and after a reload.
   */
  errorInfo?: TurnErrorInfo
  /**
   * Interactive message with action buttons (e.g. an email waiting for
   * approval). Buttons are answered via `POST /api/chat/actions/:messageId`;
   * a `chat_action_resolved` for the same `messageId` replaces them with the
   * result, no matter which channel decided.
   */
  chatAction?: ChatActionMessage
  /**
   * Interactive picker payload (slash-command driven). When present on a
   * `system` message the frontend renders a button group; clicking a button
   * sends back `{ type: 'command', content: <option.command> }`, which the
   * server re-dispatches through the slash registry to produce the next
   * picker (or final confirmation).
   */
  picker?: SlashCommandPicker
  /** Uploaded file attached to the current assistant turn (for type='attachment') */
  attachment?: UploadDescriptor
  /** Streamed thinking delta (for type='thinking') */
  thinking?: string
  toolName?: string
  toolCallId?: string
  toolArgs?: unknown
  toolResult?: unknown
  toolIsError?: boolean
  error?: string
  sessionId?: string
  /**
   * For `session_end`: the id of the session that just ended. The frontend
   * tags the rendered divider with this so a late-arriving `session_summary`
   * (background /new flow) can be matched back to the correct divider. Sent
   * explicitly because the frontend cannot reliably know the active session
   * id on its own (it is not updated by normal messages or history load).
   */
  endedSessionId?: string
  /** The source channel (for external_user_message) */
  source?: string
  /** Sender display name (for external_user_message) */
  senderName?: string
  replyContext?: string
  /** Task ID (for task events) */
  taskId?: string
  /** Task name (for task events) */
  taskName?: string
  /** Task result summary (for task events) */
  taskSummary?: string
  /** Task duration in minutes (for task events) */
  taskDurationMinutes?: number
  /** Total tokens used (for task events) */
  taskTokensUsed?: number
  /** Task trigger type (for task events) */
  taskTriggerType?: string
  /** Reminder message (for reminder events) */
  reminderMessage?: string
  /** Reminder/cronjob name (for reminder events) */
  reminderName?: string
  /** Cronjob ID (for reminder events) */
  cronjobId?: string
  /** Whether this message was also delivered to Telegram */
  telegramDelivered?: boolean
  /** Whether this is a task injection response */
  isTaskInjection?: boolean
  taskStatusContent?: string
  /** How long the task has been running, in minutes. */
  taskStatusRuntimeMinutes?: number
  /** Number of tool calls the task has made so far. */
  taskStatusToolCallCount?: number
  /** Approximate total tokens consumed by the task so far. */
  taskStatusTokensUsed?: number
}

function saveChatMessage(
  db: Database,
  sessionId: string,
  userId: number,
  role: 'user' | 'assistant' | 'tool' | 'system',
  content: string,
  metadata?: string,
): void {
  db.prepare(
    'INSERT INTO chat_messages (session_id, user_id, role, content, metadata) VALUES (?, ?, ?, ?, ?)'
  ).run(sessionId, userId, role, content, metadata ?? null)
}

export interface WebSocketChatResult {
  wss: WebSocketServer
  /** Check whether the given user ID has at least one active WebSocket connection */
  hasActiveWebSocket: (userId: number) => boolean
  /** The turn runner driving all web chat turns (shared across connections). */
  turnRunner: TurnRunner
}

/**
 * Set up WebSocket server for real-time chat
 */
export function setupWebSocketChat(
  server: Server,
  db: Database,
  getAgentCore: (() => AgentCore | null) | AgentCore | null,
  runtimeMetrics?: RuntimeMetrics,
  chatEventBus?: ChatEventBus,
  chatActions?: ChatActionRegistry | null,
): WebSocketChatResult {
  // Support both getter function and direct reference (backward compat)
  const resolveAgentCore = typeof getAgentCore === 'function' ? getAgentCore : () => getAgentCore
  const wss = new WebSocketServer({ noServer: true })

  // The runner owns the turn lifecycle (streaming, persistence, abort). This
  // handler only dispatches inbound messages into it and forwards its events,
  // which is what keeps a turn alive across socket drops and page reloads.
  let retryChannel: TurnRetryChatChannel | null = null
  const turnRunner = new TurnRunner({
    db,
    getAgent: () => resolveAgentCore(),
    onTurnStart: () => runtimeMetrics?.startRequest(),
    onTurnEnd: () => runtimeMetrics?.endRequest(),
    onTurnFailed: failure => retryChannel?.attachRetryAction(failure),
  })

  // Manual retry: the button lives on the persisted error row and is answered
  // through the chat-action registry, so it survives a reload and resolves for
  // every connected client at once.
  if (chatActions) {
    retryChannel = registerTurnRetryChatChannel({ chatActions, db, runner: turnRunner })
  }

  const slashRegistry: SlashCommandRegistry = buildWebChatSlashCommandRegistry()
  const taskStore = new TaskStore(db)
  const scheduledTaskStore = new ScheduledTaskStore(db)

  // Handle upgrade requests for /ws/chat path
  server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url ?? '', 'http://localhost').pathname
    if (pathname !== '/ws/chat') return

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request)
    })
  })

  // Track active connections
  const authenticatedClients = new Map<WebSocket, JwtPayload>()
  const clientSessions = new Map<WebSocket, string>()
  /** Unique connection ID per WebSocket (to avoid echoing messages back to sender) */
  const connectionIds = new Map<WebSocket, string>()
  /** Lookup: userId -> set of connected WebSockets */
  const userClients = new Map<number, Set<WebSocket>>()
  /** Turn-runner unsubscribe handles, one per authenticated connection. */
  const turnSubscriptions = new Map<WebSocket, () => void>()

  /**
   * Attach a connection to its user's turn stream. Subscribing replays the
   * active turn's buffer first (flagged `replay`), which is what makes a page
   * reload mid-turn look seamless.
   */
  function attachToTurns(ws: WebSocket, userId: number): void {
    turnSubscriptions.get(ws)?.()
    const detach = turnRunner.subscribe(userId, (event) => forwardTurnEvent(ws, event))
    turnSubscriptions.set(ws, detach)
  }

  wss.on('connection', (ws, req) => {
    // Try to authenticate from query parameter
    let user: JwtPayload | null = null

    if (req.url) {
      try {
        const url = new URL(req.url, 'http://localhost')
        const token = url.searchParams.get('token')
        if (token) {
          user = verifyToken(token)
        }
      } catch {
        // ignore URL parse errors
      }
    }

    if (user) {
      authenticatedClients.set(ws, user)
      const connId = crypto.randomBytes(8).toString('hex')
      connectionIds.set(ws, connId)
      // Session ID is resolved lazily from SessionManager on the first message.
      // We deliberately do NOT generate a temporary placeholder here — every
      // session ID must come from SessionManager (UUID, registered in `sessions`).

      // Track by userId
      if (!userClients.has(user.userId)) {
        userClients.set(user.userId, new Set())
      }
      userClients.get(user.userId)!.add(ws)

      sendMessage(ws, { type: 'system', text: 'Authenticated' })
      attachToTurns(ws, user.userId)
    }

    ws.on('message', async (data) => {
      let parsed: ChatMessage

      try {
        parsed = JSON.parse(data.toString())
      } catch {
        sendMessage(ws, { type: 'error', error: 'Invalid JSON message' })
        return
      }

      // Handle auth via first message if not already authenticated
      if (!authenticatedClients.has(ws)) {
        if (parsed.type === 'message' && parsed.content) {
          // Try to use content as JWT token
          const tokenUser = verifyToken(parsed.content)
          if (tokenUser) {
            authenticatedClients.set(ws, tokenUser)
            const connId = crypto.randomBytes(8).toString('hex')
            connectionIds.set(ws, connId)
            // Session ID resolved lazily from SessionManager on first message.

            // Track by userId
            if (!userClients.has(tokenUser.userId)) {
              userClients.set(tokenUser.userId, new Set())
            }
            userClients.get(tokenUser.userId)!.add(ws)

            sendMessage(ws, { type: 'system', text: 'Authenticated' })
            attachToTurns(ws, tokenUser.userId)
            return
          }
        }
        sendMessage(ws, { type: 'error', error: 'Not authenticated. Send JWT token first or connect with ?token=<jwt>' })
        return
      }

      const currentUser = authenticatedClients.get(ws)!

      // Respond to heartbeat pings immediately
      if (parsed.type === 'ping') {
        sendMessage(ws, { type: 'pong' })
        return
      }

      // Handle commands
      if (parsed.type === 'command' || parsed.content.startsWith('/')) {
        const dispatch = await slashRegistry.dispatch(parsed.content, {
          surface: 'web',
          userId: String(currentUser.userId),
          registry: slashRegistry,
          db,
          taskStore,
          scheduledTaskStore,
          onThinkingLevelChanged: (level) => resolveAgentCore()?.setThinkingLevel(level),
        })
        if (dispatch.kind === 'handled') {
          if (isSlashCommandPicker(dispatch.reply)) {
            sendMessage(ws, {
              type: 'system',
              // Title/description rendered as the bubble's text; buttons live
              // alongside via the `picker` field.
              text: formatPickerText(dispatch.reply),
              picker: dispatch.reply,
            })
          } else if (dispatch.reply !== null) {
            sendMessage(ws, { type: 'system', text: dispatch.reply })
          }
          return
        }
        if (dispatch.kind === 'not_found') {
          sendMessage(ws, {
            type: 'system',
            text: `Unknown command: /${dispatch.name}. Type /help for a list of commands.`,
          })
          return
        }
        if (dispatch.kind === 'wrong_surface') {
          sendMessage(ws, {
            type: 'system',
            text: `/${dispatch.command.name} is not available on the web chat.`,
          })
          return
        }
        const command = dispatch.kind === 'external'
          ? dispatch.command.name
          : parsed.content.replace(/^\//, '').trim().toLowerCase()

        if (command === 'new') {
          turnRunner.abortTurn(currentUser.userId)

          const agentCore = resolveAgentCore()

          if (agentCore) {
            // Capture the session id that is about to end BEFORE we reset.
            // `clientSessions` is the authoritative active-session id for this
            // connection (set on every message), so it stays correct across
            // reloads where the frontend's own session id would be null.
            const endedSessionId = clientSessions.get(ws)
            const newSession = agentCore.resetSessionAsync(String(currentUser.userId), 'web')
            clientSessions.set(ws, newSession.id)
            sendMessage(ws, {
              type: 'session_end',
              sessionId: newSession.id,
              endedSessionId,
            })
          } else {
            // No agent core: clear any cached session ID; next message will resolve a new one.
            clientSessions.delete(ws)
            sendMessage(ws, {
              type: 'session_end',
            })
          }

          return
        }

        if (command === 'stop' || command === 'kill') {
          if (!turnRunner.abortTurn(currentUser.userId)) {
            sendMessage(ws, { type: 'system', text: 'Nothing to stop.' })
            return
          }

          sendMessage(ws, { type: 'system', text: 'Task aborted. No queued messages.' })
          return
        }
      }

      // Regular message — route to agent
      // Resolve session ID from SessionManager (aligns chat_messages with session tracking).
      // SessionManager is the single source of truth: every session ID is a UUID and
      // registered in the `sessions` table.
      const agentCore = resolveAgentCore()
      if (agentCore) {
        const smSession = agentCore.getSessionManager().getOrCreateSession(String(currentUser.userId), 'web')
        clientSessions.set(ws, smSession.id)
      }
      const resolvedSessionId = clientSessions.get(ws)
      if (!resolvedSessionId) {
        sendMessage(ws, { type: 'error', error: 'Agent core not available' })
        return
      }

      if (!parsed.skipSave) {
        saveChatMessage(db, resolvedSessionId, currentUser.userId, 'user', parsed.content)
      }

      // Broadcast user message to other clients of same user (e.g. other browser tabs)
      const connId = connectionIds.get(ws)
      chatEventBus?.broadcast({
        type: 'user_message',
        userId: currentUser.userId,
        source: 'web',
        sourceConnectionId: connId,
        sessionId: resolvedSessionId,
        text: parsed.content,
      })

      if (!agentCore) {
        sendMessage(ws, { type: 'error', error: 'Agent core not available' })
        return
      }

      // Hand the turn to the runner and return. Everything the client sees —
      // chunks, attachments, stall notices, `done` — arrives through the
      // per-connection turn subscription, so the turn survives this socket
      // going away and is replayed to whoever attaches next.
      turnRunner.startTurn({
        userId: currentUser.userId,
        sessionId: resolvedSessionId,
        text: parsed.content,
        source: 'web',
        attachments: parsed.attachments,
      })
    })

    ws.on('close', () => {
      // Deliberately NOT aborting the running turn: the runner owns it, keeps
      // buffering, and replays it to the next connection that attaches.
      turnSubscriptions.get(ws)?.()
      turnSubscriptions.delete(ws)

      // Remove from user tracking
      const closingUser = authenticatedClients.get(ws)
      if (closingUser) {
        const clients = userClients.get(closingUser.userId)
        if (clients) {
          clients.delete(ws)
          if (clients.size === 0) {
            userClients.delete(closingUser.userId)
          }
        }
      }

      authenticatedClients.delete(ws)
      clientSessions.delete(ws)
      connectionIds.delete(ws)
    })
  })

  // Subscribe to cross-channel events and forward to the right web clients
  if (chatEventBus) {
    chatEventBus.subscribe((event: ChatEvent) => {
      const clients = userClients.get(event.userId)
      if (!clients || clients.size === 0) return

      for (const client of clients) {
        // Skip the connection that originated this event (avoid echo)
        const clientConnId = connectionIds.get(client)
        if (event.sourceConnectionId && clientConnId === event.sourceConnectionId) continue

        if (event.type === 'user_message') {
          sendMessage(client, {
            type: 'external_user_message',
            text: event.text,
            source: event.source,
            senderName: event.senderName,
            replyContext: event.replyContext,
          })
        } else if (event.type === 'session_end') {
          // Session ended (timeout or explicit /new). Clear the cached ID and
          // let the next actual message mint a fresh session lazily, so idle
          // users don't accumulate empty `sessions` rows on every timeout.
          clientSessions.delete(client)
          sendMessage(client, {
            type: 'session_end',
            text: event.text,
          })
        } else if (event.type === 'session_summary') {
          // Late-arriving summary for a session that was ended
          // non-blockingly (e.g. via /new). The carried `sessionId` is
          // the id of the session that just got summarized so the
          // client can match it to the previously rendered (empty)
          // divider and fill it in.
          sendMessage(client, {
            type: 'session_summary',
            sessionId: event.sessionId,
            text: event.text,
          })
        } else if (event.type === 'task_completed' || event.type === 'task_failed' || event.type === 'task_question') {
          sendMessage(client, {
            type: event.type as ChatResponse['type'],
            text: event.text,
            taskId: event.taskId,
            taskName: event.taskName,
            taskSummary: event.taskSummary,
            taskDurationMinutes: event.taskDurationMinutes,
            taskTokensUsed: event.taskTokensUsed,
            taskTriggerType: event.taskTriggerType,
          })
        } else if (event.type === 'task_status_update') {
          sendMessage(client, {
            type: 'task_status_update',
            taskId: event.taskId,
            taskName: event.taskName,
            taskTriggerType: event.taskTriggerType,
            taskStatusContent: event.taskStatusContent,
            taskStatusRuntimeMinutes: event.taskStatusRuntimeMinutes,
            taskStatusToolCallCount: event.taskStatusToolCallCount,
            taskStatusTokensUsed: event.taskStatusTokensUsed,
            sessionId: event.sessionId,
          })
        } else if (event.type === 'reminder') {
          sendMessage(client, {
            type: 'reminder',
            reminderMessage: event.reminderMessage,
            reminderName: event.reminderName,
            cronjobId: event.cronjobId,
          })
        } else if (event.type === 'chat_action' || event.type === 'chat_action_resolved') {
          sendMessage(client, {
            type: event.type,
            chatAction: event.chatAction,
          })
        } else if (event.type === 'attachment') {
          sendMessage(client, {
            type: 'attachment',
            attachment: event.attachment,
          })
        } else {
          sendMessage(client, {
            type: event.type,
            text: event.text,
            thinking: event.thinking,
            toolName: event.toolName,
            toolCallId: event.toolCallId,
            toolArgs: event.toolArgs,
            toolResult: event.toolResult,
            toolIsError: event.toolIsError,
            error: event.error,
            errorInfo: event.errorInfo,
            stall: event.stall,
            retry: event.retry,
            telegramDelivered: event.telegramDelivered,
            isTaskInjection: event.isTaskInjection,
          })
        }
      }
    })
  }

  return {
    wss,
    turnRunner,
    hasActiveWebSocket: (userId: number) => {
      const clients = userClients.get(userId)
      return !!clients && clients.size > 0
    },
  }
}

/**
 * Translate a runner event into the wire protocol. Replayed events are
 * bracketed by `turn_replay_start`/`turn_replay_end` so the client can drop
 * the partial turn it already rendered before rebuilding it from the buffer.
 */
function forwardTurnEvent(ws: WebSocket, event: TurnEvent): void {
  switch (event.type) {
    case 'turn_start':
      if (event.replay) sendMessage(ws, { type: 'turn_replay_start', sessionId: event.sessionId })
      break
    case 'chunk':
      sendMessage(ws, chunkToResponse(event.chunk))
      break
    case 'attachment':
      sendMessage(ws, { type: 'attachment', attachment: event.attachment })
      break
    case 'system':
      sendMessage(ws, { type: 'system', text: event.text })
      break
    case 'turn_end':
      if (event.replay) sendMessage(ws, { type: 'turn_replay_end' })
      break
  }
}

/**
 * Render a picker's title + description as the bubble's body text. The
 * frontend always renders the buttons separately, but we still want the
 * fallback text so old clients (or history reloads) see something.
 */
function formatPickerText(picker: SlashCommandPicker): string {
  const parts: string[] = []
  if (picker.title) parts.push(picker.title)
  if (picker.description) parts.push(picker.description)
  return parts.join('\n') || ''
}

function sendMessage(ws: WebSocket, msg: ChatResponse): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg))
  }
}

function chunkToResponse(chunk: ResponseChunk): ChatResponse {
  return {
    type: chunk.type === 'done' ? 'done' : chunk.type,
    text: chunk.text,
    thinking: chunk.thinking,
    toolName: chunk.toolName,
    toolCallId: chunk.toolCallId,
    toolArgs: chunk.toolArgs,
    toolResult: chunk.toolResult,
    toolIsError: chunk.toolIsError,
    error: chunk.error,
    errorInfo: chunk.errorInfo,
    stall: chunk.stall,
    retry: chunk.retry,
  }
}
