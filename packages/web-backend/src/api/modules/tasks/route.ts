import { Router } from 'express'
import type { Database, TaskRunner } from '@openagent/core'
import { jwtMiddleware } from '../../../auth.js'
import { createTasksController } from './controller.js'
import { createTasksService } from './service.js'

export interface TasksRouterOptions {
  db: Database
  getTaskRunner?: () => TaskRunner | null
}

export function createTasksRouter(options: TasksRouterOptions): Router {
  const router = Router()

  const service = createTasksService({
    db: options.db,
    getTaskRunner: options.getTaskRunner,
  })
  const controller = createTasksController(service)

  router.use(jwtMiddleware)

  router.get('/', controller.listTasks)
  router.get('/:id', controller.getTaskById)
  router.get('/:id/events', controller.getTaskEvents)
  router.post('/:id/kill', controller.killTask)

  return router
}
