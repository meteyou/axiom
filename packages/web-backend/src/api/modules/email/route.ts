import { Router } from 'express'
import { jwtMiddleware } from '../../../auth.js'
import type { AuthenticatedRequest } from '../../../auth.js'
import { createEmailController } from './controller.js'

export function createEmailRouter(): Router {
  const router = Router()
  const controller = createEmailController()

  router.use(jwtMiddleware)
  router.use((req: AuthenticatedRequest, res, next) => {
    if (req.user?.role !== 'admin') {
      res.status(403).json({ error: 'Admin access required' })
      return
    }

    next()
  })

  router.get('/accounts', controller.listAccounts)
  router.post('/accounts', controller.createAccount)
  router.get('/accounts/:id', controller.getAccount)
  router.put('/accounts/:id', controller.updateAccount)
  router.delete('/accounts/:id', controller.deleteAccount)

  return router
}
