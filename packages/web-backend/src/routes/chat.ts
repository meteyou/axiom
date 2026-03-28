import { Router } from 'express'
import type { Database } from '@openagent/core'
import { jwtMiddleware } from '../auth.js'
import type { AuthenticatedRequest } from '../auth.js'

export function createChatRouter(db: Database): Router {
  const router = Router()

  router.use(jwtMiddleware)

  /**
   * GET /api/chat/history
   * Query: ?session_id=xxx&page=1&limit=50
   * Returns paginated chat messages
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
        'SELECT id, session_id, user_id, role, content, metadata, timestamp FROM chat_messages WHERE user_id = ? AND session_id = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?'
      ).all(userId, sessionId, limit, offset)

      total = (db.prepare(
        'SELECT COUNT(*) as count FROM chat_messages WHERE user_id = ? AND session_id = ?'
      ).get(userId, sessionId) as { count: number }).count
    } else {
      messages = db.prepare(
        'SELECT id, session_id, user_id, role, content, metadata, timestamp FROM chat_messages WHERE user_id = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?'
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
