import type { Response } from 'express'
import type { AuthenticatedRequest } from '../../../auth.js'
import { mapTaskEventsResponse, mapTaskResponse, mapTasksListResponse } from './mapper.js'
import { parseListTasksQuery, parseTaskIdParam } from './schema.js'
import {
  TaskCannotBeKilledError,
  TaskNotFoundError,
  type TasksService,
} from './service.js'

export interface TasksController {
  listTasks: (req: AuthenticatedRequest, res: Response) => void
  getTaskById: (req: AuthenticatedRequest, res: Response) => void
  getTaskEvents: (req: AuthenticatedRequest, res: Response) => void
  killTask: (req: AuthenticatedRequest, res: Response) => void
}

export function createTasksController(service: TasksService): TasksController {
  return {
    listTasks(req, res) {
      try {
        const parsedQuery = parseListTasksQuery(req.query as Record<string, unknown>)
        if (!parsedQuery.ok) {
          res.status(400).json({ error: parsedQuery.error })
          return
        }

        const { tasks, total } = service.listTasks(parsedQuery.value)

        res.json(
          mapTasksListResponse({
            tasks,
            page: parsedQuery.value.page,
            limit: parsedQuery.value.limit,
            total,
          }),
        )
      } catch (err) {
        res.status(500).json({ error: `Failed to list tasks: ${(err as Error).message}` })
      }
    },

    getTaskById(req, res) {
      try {
        const id = parseTaskIdParam(req.params.id)
        const task = service.getTaskById(id)
        if (!task) {
          res.status(404).json({ error: 'Task not found' })
          return
        }

        res.json(mapTaskResponse(task))
      } catch (err) {
        res.status(500).json({ error: `Failed to get task: ${(err as Error).message}` })
      }
    },

    getTaskEvents(req, res) {
      try {
        const id = parseTaskIdParam(req.params.id)
        const payload = service.getTaskEvents(id)
        res.json(mapTaskEventsResponse(payload))
      } catch (err) {
        if (err instanceof TaskNotFoundError) {
          res.status(404).json({ error: err.message })
          return
        }

        res.status(500).json({ error: `Failed to get task events: ${(err as Error).message}` })
      }
    },

    killTask(req, res) {
      try {
        const id = parseTaskIdParam(req.params.id)
        const task = service.killTask(id)
        res.json(mapTaskResponse(task))
      } catch (err) {
        if (err instanceof TaskNotFoundError) {
          res.status(404).json({ error: err.message })
          return
        }

        if (err instanceof TaskCannotBeKilledError) {
          res.status(400).json({ error: err.message })
          return
        }

        res.status(500).json({ error: `Failed to kill task: ${(err as Error).message}` })
      }
    },
  }
}
