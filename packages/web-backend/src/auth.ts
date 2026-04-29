import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'
import type { Request, Response, NextFunction } from 'express'
import type { Database } from '@axiom/core'

const SALT_ROUNDS = 10
const JWT_EXPIRY = '1h'
const JWT_REFRESH_EXPIRY = '7d'

export interface JwtPayload {
  userId: number
  username: string
  role: string
}

export interface AuthenticatedRequest extends Request {
  user?: JwtPayload
}

function getJwtSecret(): string {
  return process.env.JWT_SECRET ?? 'axiom-dev-secret-change-me'
}

/**
 * Ensure admin user exists on first boot
 */
export function ensureAdminUser(db: Database): void {
  const existing = db.prepare('SELECT id FROM users WHERE role = ?').get('admin')
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
    'SELECT id, username, password_hash, role FROM users WHERE username = ?'
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
    return { userId: decoded.userId, username: decoded.username, role: decoded.role }
  } catch {
    return null
  }
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
  const payload = verifyToken(token)
  if (!payload) {
    res.status(401).json({ error: 'Invalid or expired token' })
    return
  }

  req.user = payload
  next()
}
