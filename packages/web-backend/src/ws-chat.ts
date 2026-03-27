import { WebSocketServer, WebSocket } from 'ws'
import type { Server } from 'node:http'
import type { Database } from '@openagent/core'
import type { AgentCore, ResponseChunk } from '@openagent/core'
import { verifyToken } from './auth.js'
import type { JwtPayload } from './auth.js'
import { URL } from 'node:url'
import crypto from 'node:crypto'
import type { RuntimeMetrics } from './runtime-metrics.js'

interface ChatMessage {
  type: 'message' | 'command'
  content: string
}

interface ChatResponse {
  type: 'text' | 'tool_call_start' | 'tool_call_end' | 'error' | 'done' | 'system'
  text?: string
  toolName?: string
  toolCallId?: string
  toolArgs?: unknown
  toolResult?: unknown
  toolIsError?: boolean
  error?: string
  sessionId?: string
}

function saveChatMessage(
  db: Database,
  sessionId: string,
  userId: number,
  role: 'user' | 'assistant',
  content: string
): void {
  db.prepare(
    'INSERT INTO chat_messages (session_id, user_id, role, content) VALUES (?, ?, ?, ?)'
  ).run(sessionId, userId, role, content)
}

/**
 * Set up WebSocket server for real-time chat
 */
export function setupWebSocketChat(
  server: Server,
  db: Database,
  agentCore: AgentCore | null,
  runtimeMetrics?: RuntimeMetrics,
): WebSocketServer {
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
      const sessionId = `web-${user.userId}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
      clientSessions.set(ws, sessionId)
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
            const sessionId = `web-${tokenUser.userId}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
            clientSessions.set(ws, sessionId)
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

          // Reset session
          if (agentCore) {
            agentCore.resetSession(String(currentUser.userId))
          }

          const newSessionId = `web-${currentUser.userId}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
          clientSessions.set(ws, newSessionId)
          sendMessage(ws, { type: 'system', text: 'Session reset. Starting fresh conversation.', sessionId: newSessionId })
          return
        }

        if (command === 'stop') {
          const controller = activeStreams.get(ws)
          if (controller) {
            controller.abort()
            activeStreams.delete(ws)
          }

          if (agentCore) {
            agentCore.abort()
          }

          sendMessage(ws, { type: 'system', text: 'Task aborted.' })
          return
        }
      }

      // Regular message — route to agent
      saveChatMessage(db, sessionId, currentUser.userId, 'user', parsed.content)

      if (!agentCore) {
        sendMessage(ws, { type: 'error', error: 'Agent core not available' })
        return
      }

      const abortController = new AbortController()
      activeStreams.set(ws, abortController)
      runtimeMetrics?.startRequest()

      let fullResponse = ''

      try {
        for await (const chunk of agentCore.sendMessage(String(currentUser.userId), parsed.content)) {
          if (abortController.signal.aborted) break

          if (chunk.type === 'text' && chunk.text) {
            fullResponse += chunk.text
          }

          sendMessage(ws, chunkToResponse(chunk))
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
      authenticatedClients.delete(ws)
      clientSessions.delete(ws)
      activeStreams.delete(ws)
    })
  })

  return wss
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
