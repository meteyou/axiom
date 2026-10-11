import { Router } from 'express'
import type { Database } from '@axiom/core'
import { jwtMiddleware } from '../../../auth.js'
import type { PushNotifier } from '../../../push/push-notifier.js'
import { createPushController } from './controller.js'
import { createPushService } from './service.js'

export interface PushRouterOptions {
  db: Database
  notifier: PushNotifier
}

/** Every endpoint acts on the caller's own devices only; there is no admin view. */
export function createPushRouter(options: PushRouterOptions): Router {
  const router = Router()
  const controller = createPushController(createPushService(options))

  router.use(jwtMiddleware)

  router.get('/vapid-public-key', controller.getPublicKey)
  router.get('/subscriptions', controller.listDevices)
  router.post('/subscriptions', controller.subscribe)
  router.delete('/subscriptions/:id', controller.removeDevice)
  router.post('/test', controller.sendTest)
  router.put('/preferences', controller.updatePreferences)

  return router
}
