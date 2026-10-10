import { Router } from 'express'
import type { Response } from 'express'
import {
  loadSecretsMasked,
  setSecrets,
  deleteSecret,
  injectSecretsIntoEnv,
  resolveUserScope,
} from '@axiom/core'
import type { Database } from '@axiom/core'
import { jwtMiddleware } from '../auth.js'
import type { AuthenticatedRequest } from '../auth.js'

const SECRET_KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/

interface SecretsTarget {
  /** Personal folder of a non-bootstrap user; null for the bootstrap admin, who manages the global secrets. */
  userDir: string | null
  isAdmin: boolean
}

/**
 * The bootstrap admin manages the global secrets. Every other user manages
 * personal secrets, which only reach that user's shell commands.
 */
export function createSecretsRouter(options: { db: Database }): Router {
  const router = Router()

  router.use(jwtMiddleware)

  function resolveTarget(req: AuthenticatedRequest, res: Response): SecretsTarget | null {
    const userId = req.user?.userId
    const scope = userId === undefined ? null : resolveUserScope(options.db, userId)
    if (!scope) {
      res.status(401).json({ error: 'Unknown user' })
      return null
    }
    return { userDir: scope.paths.userDir, isAdmin: scope.role === 'admin' }
  }

  function listFor(target: SecretsTarget) {
    return {
      scope: target.userDir ? 'personal' : 'global',
      secrets: loadSecretsMasked(target.userDir),
      ...(target.userDir && target.isAdmin ? { globalSecrets: loadSecretsMasked() } : {}),
    }
  }

  router.get('/', (req: AuthenticatedRequest, res) => {
    const target = resolveTarget(req, res)
    if (!target) return
    try {
      res.json(listFor(target))
    } catch (err) {
      res.status(500).json({ error: `Failed to read secrets: ${(err as Error).message}` })
    }
  })

  router.put('/', (req: AuthenticatedRequest, res) => {
    const target = resolveTarget(req, res)
    if (!target) return
    const body = req.body as { secrets?: Record<string, string> }

    if (!body.secrets || typeof body.secrets !== 'object') {
      res.status(400).json({ error: 'Body must contain a "secrets" object with key-value pairs' })
      return
    }

    for (const key of Object.keys(body.secrets)) {
      if (!SECRET_KEY_PATTERN.test(key)) {
        res.status(400).json({ error: `Invalid secret key "${key}". Keys must be uppercase with underscores only.` })
        return
      }
    }

    try {
      setSecrets(body.secrets, target.userDir)
      if (!target.userDir) injectSecretsIntoEnv()
      res.json({ message: 'Secrets updated', ...listFor(target) })
    } catch (err) {
      res.status(500).json({ error: `Failed to update secrets: ${(err as Error).message}` })
    }
  })

  router.delete('/:key', (req: AuthenticatedRequest, res) => {
    const target = resolveTarget(req, res)
    if (!target) return
    const key = req.params.key as string

    if (!key || !SECRET_KEY_PATTERN.test(key)) {
      res.status(400).json({ error: 'Invalid secret key' })
      return
    }

    try {
      deleteSecret(key, target.userDir)
      if (!target.userDir) delete process.env[key]
      res.json({ message: `Secret "${key}" deleted`, ...listFor(target) })
    } catch (err) {
      res.status(500).json({ error: `Failed to delete secret: ${(err as Error).message}` })
    }
  })

  return router
}
