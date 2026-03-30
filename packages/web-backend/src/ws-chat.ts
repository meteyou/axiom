import { WebSocketServer, WebSocket } from 'ws'
import type { Server } from 'node:http'
import type { Database } from '@openagent/core'
import type { AgentCore, ResponseChunk } from '@openagent/core'
import { verifyToken } from './auth.js'
import type { JwtPayload } from './auth.js'
import { URL } from 'node:url'
import crypto from 'node:crypto'
import type { RuntimeMetrics } from './runtime-metrics.js'
import type { ChatEventBus, ChatEvent } from './chat-event-bus.js'

interface ChatMessage {
  type: 'message' | 'command'
  content: string
}

interface ChatResponse {
  type: 'text' | 'tool_call_start' | 'tool_call_end' | 'error' | 'done' | 'system' | 'external_user_message' | 'session_end' | 'task_completed' | 'task_failed' | 'task_question'
  text?: string
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
      const sessionId = `web-${user.userId}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
      clientSessions.set(ws, sessionId)

      // Track by userId
      if (!userClients.has(user.userId)) {
        userClients.set(user.userId, new Set())
      }
      userClients.get(user.userId)!.add(ws)

      sendMessage(ws, { type: 'system', text: 'Authenticated', sessionId })
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
            const sessionId = `web-${tokenUser.userId}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
            clientSessions.set(ws, sessionId)

            // Track by userId
            if (!userClients.has(tokenUser.userId)) {
              userClients.set(tokenUser.userId, new Set())
            }
            userClients.get(tokenUser.userId)!.add(ws)

            sendMessage(ws, { type: 'system', text: 'Authenticated', sessionId })
            return
          }
        }
        sendMessage(ws, { type: 'error', error: 'Not authenticated. Send JWT token first or connect with ?token=<jwt>' })
        return
      }

      const currentUser = authenticatedClients.get(ws)!
      const sessionId = clientSessions.get(ws)!

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

          // Reset session (generates summary + writes daily log)
          let summary: string | null = null
          if (resolveAgentCore()) {
            try {
              summary = await resolveAgentCore()!.resetSession(String(currentUser.userId))
            } catch (err) {
              console.error('Failed to reset session:', err)
            }
          }

          // Save divider to DB (using old session ID, before switching)
          const dividerMetadata = JSON.stringify({ type: 'session_divider', summary: summary ?? null })
          saveChatMessage(db, sessionId, currentUser.userId, 'system', summary ?? '', dividerMetadata)

          const newSessionId = `web-${currentUser.userId}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
          clientSessions.set(ws, newSessionId)

          // Send session_end event with summary (frontend shows divider)
          sendMessage(ws, { type: 'session_end', text: summary ?? undefined, sessionId: newSessionId })
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
      saveChatMessage(db, sessionId, currentUser.userId, 'user', parsed.content)

      // Broadcast user message to other clients of same user (e.g. other browser tabs)
      const connId = connectionIds.get(ws)
      chatEventBus?.broadcast({
        type: 'user_message',
        userId: currentUser.userId,
        source: 'web',
        sourceConnectionId: connId,
        sessionId,
        text: parsed.content,
      })

      const agentCore = resolveAgentCore()
      if (!agentCore) {
        sendMessage(ws, { type: 'error', error: 'Agent core not available' })
        return
      }

      const abortController = new AbortController()
      activeStreams.set(ws, abortController)
      runtimeMetrics?.startRequest()

      let fullResponse = ''
      // Track pending tool calls to save input+output together
      const pendingToolCalls = new Map<string, { toolName: string; toolArgs: unknown }>()

      try {
        for await (const chunk of agentCore.sendMessage(String(currentUser.userId), parsed.content)) {
          if (abortController.signal.aborted) break

          if (chunk.type === 'text' && chunk.text) {
            fullResponse += chunk.text
          }

          // Track tool call start
          if (chunk.type === 'tool_call_start' && chunk.toolCallId) {
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
            saveChatMessage(db, sessionId, currentUser.userId, 'tool', `Tool: ${toolName}`, metadata)
            pendingToolCalls.delete(chunk.toolCallId)
          }

          sendMessage(ws, chunkToResponse(chunk))

          // Broadcast response chunks to other clients of same user
          chatEventBus?.broadcast({
            type: chunk.type === 'done' ? 'done' : chunk.type,
            userId: currentUser.userId,
            source: 'web',
            sourceConnectionId: connId,
            sessionId,
            text: chunk.text,
            toolName: chunk.toolName,
            toolCallId: chunk.toolCallId,
            toolArgs: chunk.toolArgs,
            toolResult: chunk.toolResult,
            toolIsError: chunk.toolIsError,
            error: chunk.error,
          })
        }

        // Save the full assistant response
        if (fullResponse) {
          saveChatMessage(db, sessionId, currentUser.userId, 'assistant', fullResponse)
        }
      } catch (err) {
        if (!abortController.signal.aborted) {
          sendMessage(ws, { type: 'error', error: `Agent error: ${(err as Error).message}` })
        }
      } finally {
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
          })
        } else if (event.type === 'session_end') {
          // Session timed out — assign new session ID and notify client
          const newSessionId = `web-${event.userId}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
          clientSessions.set(client, newSessionId)
          sendMessage(client, {
            type: 'session_end',
            text: event.text,
            sessionId: newSessionId,
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
        } else {
          sendMessage(client, {
            type: event.type,
            text: event.text,
            toolName: event.toolName,
            toolCallId: event.toolCallId,
            toolArgs: event.toolArgs,
            toolResult: event.toolResult,
            toolIsError: event.toolIsError,
            error: event.error,
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
    toolName: chunk.toolName,
    toolCallId: chunk.toolCallId,
    toolArgs: chunk.toolArgs,
    toolResult: chunk.toolResult,
    toolIsError: chunk.toolIsError,
    error: chunk.error,
  }
}
