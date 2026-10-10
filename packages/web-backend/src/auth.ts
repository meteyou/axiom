import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'
import { EventEmitter } from 'node:events'
import type { Request, Response, NextFunction } from 'express'
import type { Database } from '@axiom/core'

const SALT_ROUNDS = 10
const JWT_EXPIRY = '1h'
const JWT_REFRESH_EXPIRY = '7d'

export interface JwtPayload {
  userId: number
  username: string
  role: string
  tokenVersion?: number
}

export interface AuthenticatedRequest extends Request {
  user?: JwtPayload
}

const sessionEvents = new EventEmitter()
sessionEvents.setMaxListeners(0)

/** Subscribe to "all logins of this user were revoked"; sockets use it to close themselves. */
export function onUserSessionsRevoked(listener: (userId: number) => void): () => void {
  sessionEvents.on('revoked', listener)
  return () => sessionEvents.off('revoked', listener)
}

/** Bumps the user's token version, invalidating every issued token, and closes their sockets. */
export function revokeUserSessions(db: Database, userId: number): number {
  db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').run(userId)
  const row = db.prepare('SELECT token_version FROM users WHERE id = ?').get(userId) as { token_version: number } | undefined
  sessionEvents.emit('revoked', userId)
  return row?.token_version ?? 0
}

/** Issues a fresh access/refresh pair for the user's current role and token version. */
export function issueTokens(db: Database, userId: number): {
  accessToken: string
  refreshToken: string
  user: { id: number; username: string; role: string }
} | null {
  const row = db.prepare('SELECT id, username, role, token_version FROM users WHERE id = ?').get(userId) as
    | { id: number; username: string; role: string; token_version: number }
    | undefined
  if (!row) return null
  const payload = { userId: row.id, username: row.username, role: row.role, tokenVersion: row.token_version }
  return {
    accessToken: generateAccessToken(payload),
    refreshToken: generateRefreshToken(payload),
    user: { id: row.id, username: row.username, role: row.role },
  }
}

function getJwtSecret(): string {
  return process.env.JWT_SECRET ?? 'axiom-dev-secret-change-me'
}

/**
 * Ensure admin user exists on first boot
 */
export function ensureAdminUser(db: Database): void {
  const existing = db.prepare('SELECT id FROM users WHERE role = ? AND deleted_at IS NULL').get('admin')
  if (existing) return

  const username = process.env.ADMIN_USERNAME ?? 'admin'
  const password = process.env.ADMIN_PASSWORD ?? 'admin'
  const hash = bcrypt.hashSync(password, SALT_ROUNDS)

  db.prepare(
    'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)'
  ).run(username, hash, 'admin')

  console.log(`[axiom] Admin user "${username}" created.`)
}

/**
 * Validate credentials and return user or null
 */
export function validateCredentials(
  db: Database,
  username: string,
  password: string
): { id: number; username: string; role: string } | null {
  const row = db.prepare(
    'SELECT id, username, password_hash, role FROM users WHERE username = ? AND deleted_at IS NULL'
  ).get(username) as { id: number; username: string; password_hash: string; role: string } | undefined

  if (!row) return null
  if (!bcrypt.compareSync(password, row.password_hash)) return null

  return { id: row.id, username: row.username, role: row.role }
}

/**
 * Generate JWT access token
 */
export function generateAccessToken(payload: JwtPayload): string {
  return jwt.sign(payload, getJwtSecret(), { expiresIn: JWT_EXPIRY })
}

/**
 * Generate JWT refresh token
 */
export function generateRefreshToken(payload: JwtPayload): string {
  return jwt.sign(payload, getJwtSecret(), { expiresIn: JWT_REFRESH_EXPIRY })
}

/**
 * Verify and decode JWT token
 */
export function verifyToken(token: string): JwtPayload | null {
  try {
    const decoded = jwt.verify(token, getJwtSecret()) as JwtPayload
    return {
      userId: decoded.userId,
      username: decoded.username,
      role: decoded.role,
      tokenVersion: decoded.tokenVersion ?? 0,
    }
  } catch {
    return null
  }
}

/**
 * Verify a token and check it against the database: the user must exist and
 * the token version must match. The role is always the database's, never the token's.
 */
export function authenticateToken(db: Database, token: string): JwtPayload | null {
  const payload = verifyToken(token)
  if (!payload) return null
  const row = db.prepare('SELECT id, username, role, token_version FROM users WHERE id = ? AND deleted_at IS NULL').get(payload.userId) as
    | { id: number; username: string; role: string; token_version: number }
    | undefined
  if (!row || row.token_version !== (payload.tokenVersion ?? 0)) return null
  return { userId: row.id, username: row.username, role: row.role, tokenVersion: row.token_version }
}

/**
 * Express middleware to require JWT authentication
 */
export function jwtMiddleware(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid authorization header' })
    return
  }

  const token = authHeader.slice(7)
  const db = req.app?.locals?.db as Database | undefined
  const payload = db ? authenticateToken(db, token) : null
  if (!payload) {
    res.status(401).json({ error: 'Invalid or expired token' })
    return
  }

  req.user = payload
  next()
}
