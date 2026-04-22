import { Router } from 'express'
import type { Database, ProviderConfig, TaskRuntimeTaskBoundary } from '@axiom/core'
import { jwtMiddleware } from '../../../auth.js'
import { createTasksController } from './controller.js'
import { createTasksService } from './service.js'

export interface TasksRouterOptions {
  db: Database
  getTaskRuntime?: () => TaskRuntimeTaskBoundary | null
  /** Look up a provider by id/name — needed for the restart endpoint. */
  resolveProvider?: (nameOrId: string) => ProviderConfig | null
  /** Configured task default provider — used when restart omits provider/model. */
  getDefaultProvider?: () => ProviderConfig | null
}

export function createTasksRouter(options: TasksRouterOptions): Router {
  const router = Router()

  const service = createTasksService({
    db: options.db,
    getTaskRuntime: options.getTaskRuntime,
    resolveProvider: options.resolveProvider,
    getDefaultProvider: options.getDefaultProvider,
  })
  const controller = createTasksController(service)

  router.use(jwtMiddleware)

  router.get('/', controller.listTasks)
  router.get('/:id', controller.getTaskById)
  router.get('/:id/events', controller.getTaskEvents)
  router.post('/:id/kill', controller.killTask)
  router.post('/:id/restart', controller.restartTask)

  return router
}
