import { WebSocketServer, WebSocket } from 'ws'
import type { Server } from 'node:http'
import type { Database, UploadDescriptor } from '@axiom/core'
import type { AgentCore, ResponseChunk } from '@axiom/core'
import { extractUploadsFromToolResult, serializeUploadsMetadata } from '@axiom/core'
import { verifyToken } from './auth.js'
import type { JwtPayload } from './auth.js'
import { URL } from 'node:url'
import crypto from 'node:crypto'
import type { RuntimeMetrics } from './runtime-metrics.js'
import type { ChatEventBus, ChatEvent } from './chat-event-bus.js'

interface ChatMessage {
  type: 'message' | 'command' | 'ping'
  content: string
  /** When true, skip saving to DB (message already persisted via HTTP upload) */
  skipSave?: boolean
  /** Upload descriptors for file attachments (passed when skipSave is true) */
  attachments?: UploadDescriptor[]
}

interface ChatResponse {
  type: 'text' | 'thinking' | 'tool_call_start' | 'tool_call_end' | 'error' | 'done' | 'system' | 'external_user_message' | 'session_end' | 'task_completed' | 'task_failed' | 'task_question' | 'task_status_update' | 'reminder' | 'pong' | 'attachment'
  text?: string
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
  /** The source channel (for external_user_message) */
  source?: string
  /** Sender display name (for external_user_message) */
  senderName?: string
  /**
   * Excerpt of the message the user replied to (Telegram reply-to), truncated to 500 chars.
   * Rendered as a quote bubble above the user message. Only set for `external_user_message`.
   */
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
  /**
   * Human-readable single-line summary for `task_status_update` events,
   * matching the value persisted in `chat_messages.content`.
   */
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
): WebSocketChatResult {
  // Support both getter function and direct reference (backward compat)
  const resolveAgentCore = typeof getAgentCore === 'function' ? getAgentCore : () => getAgentCore
  const wss = new WebSocketServer({ noServer: true })

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
  const activeStreams = new Map<WebSocket, AbortController>()
  /** Unique connection ID per WebSocket (to avoid echoing messages back to sender) */
  const connectionIds = new Map<WebSocket, string>()
  /** Lookup: userId -> set of connected WebSockets */
  const userClients = new Map<number, Set<WebSocket>>()

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
        const command = parsed.content.replace(/^\//, '').trim().toLowerCase()

        if (command === 'new') {
          // Abort any active stream
          const controller = activeStreams.get(ws)
          if (controller) {
            controller.abort()
            activeStreams.delete(ws)
          }

          const agentCore = resolveAgentCore()

          // Reset session (generates summary + writes daily log).
          // When a chat event bus is available, the resulting session_end event is
          // emitted centrally via onSessionEnd and broadcast from there to avoid
          // duplicate dividers. Otherwise, emit the divider directly here.
          if (agentCore) {
            try {
              const summary = await agentCore.resetSession(String(currentUser.userId))
              if (!chatEventBus) {
                // After resetSession, the next getOrCreateSession() returns a fresh UUID.
                const newSession = agentCore.getSessionManager().getOrCreateSession(String(currentUser.userId), 'web')
                clientSessions.set(ws, newSession.id)
                sendMessage(ws, {
                  type: 'session_end',
                  text: summary ?? undefined,
                  sessionId: newSession.id,
                })
              }
            } catch (err) {
              console.error('Failed to reset session:', err)
              if (!chatEventBus) {
                const newSession = agentCore.getSessionManager().getOrCreateSession(String(currentUser.userId), 'web')
                clientSessions.set(ws, newSession.id)
                sendMessage(ws, {
                  type: 'session_end',
                  sessionId: newSession.id,
                })
              }
            }
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
          const controller = activeStreams.get(ws)
          if (!controller) {
            sendMessage(ws, { type: 'system', text: 'Nothing to stop.' })
            return
          }

          controller.abort()
          activeStreams.delete(ws)

          if (resolveAgentCore()) {
            resolveAgentCore()!.abort()
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

      const abortController = new AbortController()
      activeStreams.set(ws, abortController)
      runtimeMetrics?.startRequest()

      let fullResponse = ''
      let doneSent = false
      // Track pending tool calls to save input+output together
      const pendingToolCalls = new Map<string, { toolName: string; toolArgs: unknown }>()
      // Collect any uploads produced by tools during this turn (e.g.
      // `send_file_to_user`). These are:
      //   1. streamed live to the client via `attachment` ws messages so
      //      the download card appears next to the assistant bubble
      //      without a reload, and
      //   2. merged into the saved assistant message's metadata so a
      //      history reload shows the same attachment(s).
      // Channel-agnostic extraction (via `extractUploadsFromToolResult`)
      // means any tool can produce files, not just the built-in sender.
      const assistantUploads: UploadDescriptor[] = []
      // Buffer thinking deltas between thinking_start/thinking_end boundaries. Because
      // the core runtime only surfaces `thinking_delta` today, we treat each contiguous
      // run of thinking chunks (i.e. uninterrupted by text/tool/done) as a single block
      // and persist it as its own chat_messages row with metadata.kind === 'thinking'.
      let currentThinking = ''
      const flushThinking = () => {
        if (!currentThinking) return
        const thinkingText = currentThinking
        currentThinking = ''
        try {
          saveChatMessage(
            db,
            resolvedSessionId,
            currentUser.userId,
            'assistant',
            thinkingText,
            JSON.stringify({ kind: 'thinking' }),
          )
        } catch (err) {
          console.error('Failed to persist thinking block:', err)
        }
      }

      try {
        for await (const chunk of agentCore.sendMessage(String(currentUser.userId), parsed.content, 'web', parsed.attachments)) {
          if (abortController.signal.aborted) break

          if (chunk.type === 'text' && chunk.text) {
            // Any text closes an in-progress thinking block.
            flushThinking()
            fullResponse += chunk.text
          }

          if (chunk.type === 'thinking' && chunk.thinking) {
            currentThinking += chunk.thinking
          }

          if (chunk.type === 'done') {
            flushThinking()
            doneSent = true
          }

          // Track tool call start
          if (chunk.type === 'tool_call_start' && chunk.toolCallId) {
            // Tool calls also end the current thinking block.
            flushThinking()
            pendingToolCalls.set(chunk.toolCallId, {
              toolName: chunk.toolName ?? 'unknown',
              toolArgs: chunk.toolArgs,
            })
          }

          // Save completed tool call to DB
          if (chunk.type === 'tool_call_end' && chunk.toolCallId) {
            const pending = pendingToolCalls.get(chunk.toolCallId)
            const toolName = pending?.toolName ?? chunk.toolName ?? 'unknown'
            const metadata = JSON.stringify({
              toolName,
              toolCallId: chunk.toolCallId,
              toolArgs: pending?.toolArgs ?? null,
              toolResult: chunk.toolResult ?? null,
              toolIsError: chunk.toolIsError ?? false,
            })
            saveChatMessage(db, resolvedSessionId, currentUser.userId, 'tool', `Tool: ${toolName}`, metadata)
            pendingToolCalls.delete(chunk.toolCallId)

            // Harvest any uploads produced by this tool and forward them as
            // `attachment` events so the frontend can render them inline
            // on the active assistant message.
            const newUploads = extractUploadsFromToolResult(chunk.toolResult)
            for (const upload of newUploads) {
              assistantUploads.push(upload)
              sendMessage(ws, { type: 'attachment', attachment: upload })
              // Fan out to other tabs of the same user so every connected
              // client renders the attachment, not just the one that drove
              // the turn.
              chatEventBus?.broadcast({
                type: 'attachment',
                userId: currentUser.userId,
                source: 'web',
                sourceConnectionId: connId,
                sessionId: resolvedSessionId,
                attachment: upload,
              })
            }
          }

          sendMessage(ws, chunkToResponse(chunk))

          // Broadcast response chunks to other clients of same user
          chatEventBus?.broadcast({
            type: chunk.type === 'done' ? 'done' : chunk.type,
            userId: currentUser.userId,
            source: 'web',
            sourceConnectionId: connId,
            sessionId: resolvedSessionId,
            text: chunk.text,
            thinking: chunk.thinking,
            toolName: chunk.toolName,
            toolCallId: chunk.toolCallId,
            toolArgs: chunk.toolArgs,
            toolResult: chunk.toolResult,
            toolIsError: chunk.toolIsError,
            error: chunk.error,
          })
        }

        // Save the full assistant response, including attachment metadata.
        // If the turn produced only attachments (no text), we still persist
        // an assistant row with empty content so the download card is
        // recoverable on history reload.
        if (fullResponse || assistantUploads.length > 0) {
          const metadata = assistantUploads.length > 0
            ? serializeUploadsMetadata(assistantUploads)
            : undefined
          saveChatMessage(
            db,
            resolvedSessionId,
            currentUser.userId,
            'assistant',
            fullResponse,
            metadata,
          )
        }
      } catch (err) {
        if (!abortController.signal.aborted) {
          sendMessage(ws, { type: 'error', error: `Agent error: ${(err as Error).message}` })
        }
      } finally {
        // Flush any trailing thinking that wasn't closed by text/tool/done (e.g.
        // aborted/errored streams) so reload shows the partial reasoning.
        flushThinking()
        // Always send a 'done' if one wasn't already sent, so the frontend
        // never gets stuck with a streaming indicator that never resolves.
        if (!doneSent) {
          sendMessage(ws, { type: 'done' })
          chatEventBus?.broadcast({
            type: 'done',
            userId: currentUser.userId,
            source: 'web',
            sourceConnectionId: connId,
            sessionId: resolvedSessionId,
          })
        }
        activeStreams.delete(ws)
        runtimeMetrics?.endRequest()
      }
    })

    ws.on('close', () => {
      const controller = activeStreams.get(ws)
      if (controller) controller.abort()

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
      activeStreams.delete(ws)
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
            telegramDelivered: event.telegramDelivered,
            isTaskInjection: event.isTaskInjection,
          })
        }
      }
    })
  }

  return {
    wss,
    hasActiveWebSocket: (userId: number) => {
      const clients = userClients.get(userId)
      return !!clients && clients.size > 0
    },
  }
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
  }
}
