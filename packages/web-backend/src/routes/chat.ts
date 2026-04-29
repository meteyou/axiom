import { Router } from 'express'
import type { Database, AgentCore } from '@axiom/core'
import { saveUpload, serializeUploadsMetadata } from '@axiom/core'
import { jwtMiddleware } from '../auth.js'
import type { AuthenticatedRequest } from '../auth.js'
import { uploadMiddleware } from '../uploads.js'

export interface ChatRouterOptions {
  db: Database
  /** Resolves the live AgentCore (and via it, SessionManager). May return null
   * if the agent isn't available yet — in which case the REST upload endpoint
   * cannot create a tracked session and will return an error. */
  getAgentCore?: () => AgentCore | null
}

export function createChatRouter(options: ChatRouterOptions): Router {
  const { db } = options
  const getAgentCore = options.getAgentCore ?? (() => null)
  const router = Router()

  router.use(jwtMiddleware)

  router.post('/message', uploadMiddleware.array('files', 5), (req: AuthenticatedRequest, res) => {
    const userId = req.user!.userId
    const text = typeof req.body?.content === 'string' ? req.body.content.trim() : ''
    const files = (req.files as Express.Multer.File[] | undefined) ?? []

    if (!text && files.length === 0) {
      res.status(400).json({ error: 'Message content or at least one file is required' })
      return
    }

    // Resolve a tracked interactive session via SessionManager. Source is
    // 'web' — this REST endpoint is the upload prelude for a WebSocket chat
    // message, so the session belongs to the web channel. Using 'rest' here
    // would leak into the cached session and mistag subsequent WS messages
    // (the cache keeps the initial source), corrupting source-based filters
    // in chat history, logs, and usage stats.
    const agentCore = getAgentCore()
    if (!agentCore) {
      res.status(503).json({ error: 'Agent core not available' })
      return
    }
    const session = agentCore.getSessionManager().getOrCreateSession(String(userId), 'web')
    const sessionId = session.id

    const uploads = files.map(file => saveUpload({
      buffer: file.buffer,
      originalName: file.originalname,
      mimeType: file.mimetype,
      source: 'web',
      userId,
      sessionId,
    }))

    const metadata = uploads.length > 0 ? serializeUploadsMetadata(uploads) : null
    db.prepare(
      'INSERT INTO chat_messages (session_id, user_id, role, content, metadata) VALUES (?, ?, ?, ?, ?)'
    ).run(sessionId, userId, 'user', text, metadata)

    res.status(201).json({
      message: {
        session_id: sessionId,
        user_id: userId,
        role: 'user',
        content: text,
        metadata,
        timestamp: new Date().toISOString(),
      },
    })
  })

  /**
   * GET /api/chat/history
   * Query: ?session_id=xxx&page=1&limit=50
   * Returns paginated chat messages, joined with `sessions` so each message
   * carries the originating `source` (web, telegram, rest, ...). The frontend
   * uses `source` instead of inferring from session-ID prefixes.
   */
  router.get('/history', (req: AuthenticatedRequest, res) => {
    const sessionId = req.query.session_id as string | undefined
    const page = Math.max(1, parseInt(req.query.page as string) || 1)
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 50))
    const offset = (page - 1) * limit
    const userId = req.user!.userId

    let messages: unknown[]
    let total: number

    if (sessionId) {
      messages = db.prepare(
        `SELECT cm.id, cm.session_id, cm.user_id, cm.role, cm.content, cm.metadata, cm.timestamp,
                s.source AS source, s.type AS session_type
         FROM chat_messages cm
         LEFT JOIN sessions s ON s.id = cm.session_id
         WHERE cm.user_id = ? AND cm.session_id = ?
         ORDER BY cm.timestamp DESC LIMIT ? OFFSET ?`
      ).all(userId, sessionId, limit, offset)

      total = (db.prepare(
        'SELECT COUNT(*) as count FROM chat_messages WHERE user_id = ? AND session_id = ?'
      ).get(userId, sessionId) as { count: number }).count
    } else {
      messages = db.prepare(
        `SELECT cm.id, cm.session_id, cm.user_id, cm.role, cm.content, cm.metadata, cm.timestamp,
                s.source AS source, s.type AS session_type
         FROM chat_messages cm
         LEFT JOIN sessions s ON s.id = cm.session_id
         WHERE cm.user_id = ?
         ORDER BY cm.timestamp DESC LIMIT ? OFFSET ?`
      ).all(userId, limit, offset)

      total = (db.prepare(
        'SELECT COUNT(*) as count FROM chat_messages WHERE user_id = ?'
      ).get(userId) as { count: number }).count
    }

    res.json({
      messages,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    })
  })

  /**
   * GET /api/chat/sessions
   * Returns list of chat sessions for the current user
   */
  router.get('/sessions', (req: AuthenticatedRequest, res) => {
    const userId = req.user!.userId

    const sessions = db.prepare(`
      SELECT DISTINCT session_id,
        MIN(timestamp) as started_at,
        MAX(timestamp) as last_message_at,
        COUNT(*) as message_count
      FROM chat_messages
      WHERE user_id = ?
      GROUP BY session_id
      ORDER BY last_message_at DESC
    `).all(userId)

    res.json({ sessions })
  })

  return router
}
