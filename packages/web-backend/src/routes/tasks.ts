import { Router } from 'express'
import type { Database } from '@openagent/core'
import { TaskStore } from '@openagent/core'
import type { TaskStatus, TaskTriggerType } from '@openagent/core'
import type { TaskRunner } from '@openagent/core'
import { getToolCalls } from '@openagent/core'
import { jwtMiddleware } from '../auth.js'
import type { AuthenticatedRequest } from '../auth.js'

const VALID_STATUSES: TaskStatus[] = ['running', 'paused', 'completed', 'failed']
const VALID_TRIGGER_TYPES: TaskTriggerType[] = ['user', 'agent', 'cronjob']

export interface TasksRouterOptions {
  db: Database
  getTaskRunner?: () => TaskRunner | null
}

export function createTasksRouter(options: TasksRouterOptions): Router {
  const router = Router()
  const store = new TaskStore(options.db)

  router.use(jwtMiddleware)

  /**
   * GET /api/tasks
   * Query: ?status=running&trigger_type=user&page=1&limit=20
   * Returns paginated task list with filters
   */
  router.get('/', (req: AuthenticatedRequest, res) => {
    try {
      const page = Math.max(1, parseInt(req.query.page as string) || 1)
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20))
      const offset = (page - 1) * limit

      const statusParam = req.query.status as string | undefined
      const triggerTypeParam = req.query.trigger_type as string | undefined

      // Validate filters
      if (statusParam && !VALID_STATUSES.includes(statusParam as TaskStatus)) {
        res.status(400).json({ error: `Invalid status filter. Must be one of: ${VALID_STATUSES.join(', ')}` })
        return
      }
      if (triggerTypeParam && !VALID_TRIGGER_TYPES.includes(triggerTypeParam as TaskTriggerType)) {
        res.status(400).json({ error: `Invalid trigger_type filter. Must be one of: ${VALID_TRIGGER_TYPES.join(', ')}` })
        return
      }

      const status = statusParam as TaskStatus | undefined
      const triggerType = triggerTypeParam as TaskTriggerType | undefined

      // Get tasks with pagination
      const tasks = store.list({ status, triggerType, limit, offset })

      // Get total count for pagination
      let countSql = 'SELECT COUNT(*) as count FROM tasks WHERE 1=1'
      const countParams: unknown[] = []
      if (status) {
        countSql += ' AND status = ?'
        countParams.push(status)
      }
      if (triggerType) {
        countSql += ' AND trigger_type = ?'
        countParams.push(triggerType)
      }
      const total = (options.db.prepare(countSql).get(...countParams) as { count: number }).count

      res.json({
        tasks,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      })
    } catch (err) {
      res.status(500).json({ error: `Failed to list tasks: ${(err as Error).message}` })
    }
  })

  /**
   * GET /api/tasks/:id
   * Returns full task detail including all columns
   */
  router.get('/:id', (req: AuthenticatedRequest, res) => {
    try {
      const id = String(req.params.id)
      const task = store.getById(id)
      if (!task) {
        res.status(404).json({ error: 'Task not found' })
        return
      }
      res.json({ task })
    } catch (err) {
      res.status(500).json({ error: `Failed to get task: ${(err as Error).message}` })
    }
  })

  /**
   * GET /api/tasks/:id/events
   * Returns ordered list of tool calls and chat messages for a task's session_id
   */
  router.get('/:id/events', (req: AuthenticatedRequest, res) => {
    try {
      const id = String(req.params.id)
      const task = store.getById(id)
      if (!task) {
        res.status(404).json({ error: 'Task not found' })
        return
      }

      const sessionId = task.sessionId ?? `task-${task.id}`

      // Get tool calls for this task's session
      const toolCalls = getToolCalls(options.db, { sessionId })
        // getToolCalls returns DESC order; reverse to chronological
        .reverse()
        .map(tc => ({
          type: 'tool_call' as const,
          timestamp: tc.timestamp,
          toolName: tc.toolName,
          input: tc.input,
          output: tc.output,
          durationMs: tc.durationMs,
          status: tc.status ?? 'success',
        }))

      // Get chat messages for this task's session
      const messages = (options.db.prepare(
        'SELECT role, content, metadata, timestamp FROM chat_messages WHERE session_id = ? ORDER BY timestamp ASC'
      ).all(sessionId) as { role: string; content: string; metadata: string | null; timestamp: string }[])
        .filter(m => m.role === 'assistant' || m.role === 'system')
        .map(m => ({
          type: 'message' as const,
          timestamp: m.timestamp,
          role: m.role,
          content: m.content,
          metadata: m.metadata ? JSON.parse(m.metadata) : null,
        }))

      // Merge and sort chronologically
      const events = [...toolCalls, ...messages].sort((a, b) =>
        (a.timestamp ?? '').localeCompare(b.timestamp ?? '')
      )

      res.json({ events, task: { id: task.id, name: task.name, status: task.status, prompt: task.prompt } })
    } catch (err) {
      res.status(500).json({ error: `Failed to get task events: ${(err as Error).message}` })
    }
  })

  /**
   * POST /api/tasks/:id/kill
   * Aborts a running task via Task Runner
   */
  router.post('/:id/kill', (req: AuthenticatedRequest, res) => {
    try {
      const id = String(req.params.id)
      const task = store.getById(id)
      if (!task) {
        res.status(404).json({ error: 'Task not found' })
        return
      }

      if (task.status !== 'running') {
        res.status(400).json({ error: `Cannot kill task with status '${task.status}'. Only running tasks can be killed.` })
        return
      }

      const taskRunner = options.getTaskRunner?.()
      if (taskRunner) {
        taskRunner.abortTask(task.id, 'Killed by user from web UI')
      } else {
        // No task runner available — update status directly
        const now = new Date().toISOString().replace('T', ' ').slice(0, 19)
        store.update(task.id, {
          status: 'failed',
          resultStatus: 'failed',
          resultSummary: 'Killed by user from web UI',
          errorMessage: 'Killed by user from web UI',
          completedAt: now,
        })
      }

      // Return updated task
      const updatedTask = store.getById(task.id)
      res.json({ task: updatedTask })
    } catch (err) {
      res.status(500).json({ error: `Failed to kill task: ${(err as Error).message}` })
    }
  })

  return router
}
