import { Router } from 'express'
import type { Database } from '@axiom/core'
import {
  validateCredentials,
  generateAccessToken,
  generateRefreshToken,
  verifyToken,
  jwtMiddleware,
} from '../auth.js'
import type { AuthenticatedRequest } from '../auth.js'

export function createAuthRouter(db: Database): Router {
  const router = Router()

  /**
   * POST /api/auth/login
   * Body: { username, password }
   * Returns: { accessToken, refreshToken, user }
   */
  router.post('/login', (req, res) => {
    const { username, password } = req.body as { username?: string; password?: string }

    if (!username || !password) {
      res.status(400).json({ error: 'Username and password are required' })
      return
    }

    const user = validateCredentials(db, username, password)
    if (!user) {
      res.status(401).json({ error: 'Invalid credentials' })
      return
    }

    const payload = { userId: user.id, username: user.username, role: user.role }
    const accessToken = generateAccessToken(payload)
    const refreshToken = generateRefreshToken(payload)

    res.json({
      accessToken,
      refreshToken,
      user: { id: user.id, username: user.username, role: user.role },
    })
  })

  /**
   * POST /api/auth/refresh
   * Body: { refreshToken }
   * Returns: { accessToken, refreshToken }
   */
  router.post('/refresh', (req, res) => {
    const { refreshToken } = req.body as { refreshToken?: string }

    if (!refreshToken) {
      res.status(400).json({ error: 'Refresh token is required' })
      return
    }

    const payload = verifyToken(refreshToken)
    if (!payload) {
      res.status(401).json({ error: 'Invalid or expired refresh token' })
      return
    }

    // Verify user still exists
    const user = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(payload.userId) as
      | { id: number; username: string; role: string }
      | undefined

    if (!user) {
      res.status(401).json({ error: 'User no longer exists' })
      return
    }

    const newPayload = { userId: user.id, username: user.username, role: user.role }
    const newAccessToken = generateAccessToken(newPayload)
    const newRefreshToken = generateRefreshToken(newPayload)

    res.json({
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      user: { id: user.id, username: user.username, role: user.role },
    })
  })

  /**
   * GET /api/auth/me
   * Returns: { user: { userId, username, role } }
   * Validates the current access token and confirms the user still exists.
   */
  router.get('/me', jwtMiddleware, (req: AuthenticatedRequest, res) => {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' })
      return
    }

    // Verify user still exists in the database
    const user = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(req.user.userId) as
      | { id: number; username: string; role: string }
      | undefined

    if (!user) {
      res.status(401).json({ error: 'User no longer exists' })
      return
    }

    res.json({
      user: { id: user.id, username: user.username, role: user.role },
    })
  })

  /**
   * POST /api/auth/logout
   * (Stateless JWT — client just discards token; endpoint exists for API completeness)
   */
  router.post('/logout', jwtMiddleware, (_req: AuthenticatedRequest, res) => {
    res.json({ message: 'Logged out successfully' })
  })

  return router
}
