import { Router } from 'express'
import type { NextFunction, Response } from 'express'
import type { Database } from '@axiom/core'
import { jwtMiddleware } from '../../../auth.js'
import type { AuthenticatedRequest } from '../../../auth.js'
import { createEmailController } from './controller.js'

export interface EmailRouterOptions {
  db: Database
}

export function createEmailRouter(options: EmailRouterOptions): Router {
  const router = Router()
  const controller = createEmailController({ db: options.db })

  router.use(jwtMiddleware)

  // Read-only audit view — every authenticated user may inspect what the agent sent.
  router.get('/sent-log', controller.listSendLog)
  router.get('/sent-log/:id', controller.getSendLogEntry)

  router.use('/accounts', (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (req.user?.role !== 'admin') {
      res.status(403).json({ error: 'Admin access required' })
      return
    }

    next()
  })

  router.get('/accounts', controller.listAccounts)
  router.post('/accounts', controller.createAccount)
  router.post('/accounts/test-connection', controller.testConnection)
  router.post('/accounts/folders', controller.listFolders)
  router.get('/accounts/:id', controller.getAccount)
  router.put('/accounts/:id', controller.updateAccount)
  router.delete('/accounts/:id', controller.deleteAccount)

  return router
}
