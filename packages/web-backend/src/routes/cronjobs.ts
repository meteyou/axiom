import { Router } from 'express'
import type { Database, TaskRuntimeScheduleBoundary } from '@openagent/core'
import { ScheduledTaskStore, validateCronExpression, cronToHumanReadable } from '@openagent/core'
import { jwtMiddleware } from '../auth.js'
import type { AuthenticatedRequest } from '../auth.js'

export interface CronjobsRouterOptions {
  db: Database
  getTaskRuntime?: () => TaskRuntimeScheduleBoundary | null
}

export function createCronjobsRouter(options: CronjobsRouterOptions): Router {
  const router = Router()
  const store = new ScheduledTaskStore(options.db)

  const getTaskRuntime = (): TaskRuntimeScheduleBoundary | null => options.getTaskRuntime?.() ?? null

  router.use(jwtMiddleware)

  /**
   * GET /api/cronjobs
   * Returns all scheduled tasks
   */
  router.get('/', (_req: AuthenticatedRequest, res) => {
    try {
      const taskRuntime = getTaskRuntime()
      const cronjobs = taskRuntime ? taskRuntime.list() : store.list()

      // Enrich with human-readable schedule
      const enriched = cronjobs.map(cj => ({
        ...cj,
        scheduleHuman: cronToHumanReadable(cj.schedule),
      }))

      res.json({ cronjobs: enriched })
    } catch (err) {
      res.status(500).json({ error: `Failed to list cronjobs: ${(err as Error).message}` })
    }
  })

  /**
   * POST /api/cronjobs
   * Creates a new scheduled task
   */
  router.post('/', (req: AuthenticatedRequest, res) => {
    try {
      const { name, prompt, schedule, actionType, provider, enabled } = req.body as {
        name?: string
        prompt?: string
        schedule?: string
        actionType?: string
        provider?: string
        enabled?: boolean
      }

      if (!name || !prompt || !schedule) {
        res.status(400).json({ error: 'Missing required fields: name, prompt, schedule' })
        return
      }

      // Validate cron expression
      const validationError = validateCronExpression(schedule)
      if (validationError) {
        res.status(400).json({ error: `Invalid cron expression: ${validationError}` })
        return
      }

      const taskRuntime = getTaskRuntime()
      const cronjob = taskRuntime
        ? taskRuntime.create({
            name,
            prompt,
            schedule,
            actionType: actionType === 'injection' ? 'injection' : 'task',
            provider: provider || undefined,
            enabled: enabled !== undefined ? enabled : true,
          })
        : store.create({
            name,
            prompt,
            schedule,
            actionType: actionType === 'injection' ? 'injection' : 'task',
            provider: provider || undefined,
            enabled: enabled !== undefined ? enabled : true,
          })

      // Register with scheduler boundary when available
      if (taskRuntime) {
        taskRuntime.register(cronjob)
      }

      res.status(201).json({
        cronjob: {
          ...cronjob,
          scheduleHuman: cronToHumanReadable(cronjob.schedule),
        },
      })
    } catch (err) {
      res.status(500).json({ error: `Failed to create cronjob: ${(err as Error).message}` })
    }
  })

  /**
   * PUT /api/cronjobs/:id
   * Updates a scheduled task
   */
  router.put('/:id', (req: AuthenticatedRequest, res) => {
    try {
      const id = String(req.params.id)
      const taskRuntime = getTaskRuntime()
      const existing = taskRuntime ? taskRuntime.getById(id) : store.getById(id)
      if (!existing) {
        res.status(404).json({ error: 'Cronjob not found' })
        return
      }

      const { name, prompt, schedule, actionType, provider, enabled, toolsOverride, skillsOverride, systemPromptOverride } = req.body as {
        name?: string
        prompt?: string
        schedule?: string
        actionType?: string
        provider?: string
        enabled?: boolean
        toolsOverride?: string | null
        skillsOverride?: string | null
        systemPromptOverride?: string | null
      }

      // Validate cron expression if provided
      if (schedule) {
        const validationError = validateCronExpression(schedule)
        if (validationError) {
          res.status(400).json({ error: `Invalid cron expression: ${validationError}` })
          return
        }
      }

      // Validate override JSON formats
      if (toolsOverride !== undefined && toolsOverride !== null) {
        try {
          const parsed = JSON.parse(toolsOverride)
          if (!Array.isArray(parsed) || !parsed.every((v: unknown) => typeof v === 'string')) {
            res.status(400).json({ error: 'toolsOverride must be a JSON array of strings' })
            return
          }
        } catch {
          res.status(400).json({ error: 'toolsOverride must be valid JSON' })
          return
        }
      }

      if (skillsOverride !== undefined && skillsOverride !== null) {
        try {
          const parsed = JSON.parse(skillsOverride)
          if (!Array.isArray(parsed) || !parsed.every((v: unknown) => typeof v === 'string')) {
            res.status(400).json({ error: 'skillsOverride must be a JSON array of strings' })
            return
          }
        } catch {
          res.status(400).json({ error: 'skillsOverride must be valid JSON' })
          return
        }
      }

      if (systemPromptOverride !== undefined && systemPromptOverride !== null && typeof systemPromptOverride !== 'string') {
        res.status(400).json({ error: 'systemPromptOverride must be a string' })
        return
      }

      const updated = taskRuntime
        ? taskRuntime.update(id, {
            name,
            prompt,
            schedule,
            actionType: actionType !== undefined ? (actionType === 'injection' ? 'injection' : 'task') : undefined,
            provider,
            enabled,
            toolsOverride: toolsOverride !== undefined ? toolsOverride : undefined,
            skillsOverride: skillsOverride !== undefined ? skillsOverride : undefined,
            systemPromptOverride: systemPromptOverride !== undefined ? systemPromptOverride : undefined,
          })
        : store.update(id, {
            name,
            prompt,
            schedule,
            actionType: actionType !== undefined ? (actionType === 'injection' ? 'injection' : 'task') : undefined,
            provider,
            enabled,
            toolsOverride: toolsOverride !== undefined ? toolsOverride : undefined,
            skillsOverride: skillsOverride !== undefined ? skillsOverride : undefined,
            systemPromptOverride: systemPromptOverride !== undefined ? systemPromptOverride : undefined,
          })

      if (!updated) {
        res.status(500).json({ error: 'Failed to update cronjob' })
        return
      }

      // Re-register with scheduler boundary when available
      if (taskRuntime) {
        taskRuntime.register(updated)
      }

      res.json({
        cronjob: {
          ...updated,
          scheduleHuman: cronToHumanReadable(updated.schedule),
        },
      })
    } catch (err) {
      res.status(500).json({ error: `Failed to update cronjob: ${(err as Error).message}` })
    }
  })

  /**
   * DELETE /api/cronjobs/:id
   * Deletes a scheduled task
   */
  router.delete('/:id', (req: AuthenticatedRequest, res) => {
    try {
      const id = String(req.params.id)
      const taskRuntime = getTaskRuntime()
      const existing = taskRuntime ? taskRuntime.getById(id) : store.getById(id)
      if (!existing) {
        res.status(404).json({ error: 'Cronjob not found' })
        return
      }

      // Unregister from scheduler boundary when available
      if (taskRuntime) {
        taskRuntime.unregister(id)
      }

      const deleted = taskRuntime ? taskRuntime.delete(id) : store.delete(id)
      if (!deleted) {
        res.status(500).json({ error: 'Failed to delete cronjob' })
        return
      }

      res.json({ success: true })
    } catch (err) {
      res.status(500).json({ error: `Failed to delete cronjob: ${(err as Error).message}` })
    }
  })

  /**
   * POST /api/cronjobs/:id/trigger
   * Manually triggers a cronjob (runs it immediately via Task Runner)
   */
  router.post('/:id/trigger', async (req: AuthenticatedRequest, res) => {
    try {
      const id = String(req.params.id)
      const taskRuntime = getTaskRuntime()
      const existing = taskRuntime ? taskRuntime.getById(id) : store.getById(id)
      if (!existing) {
        res.status(404).json({ error: 'Cronjob not found' })
        return
      }

      if (!taskRuntime) {
        res.status(503).json({ error: 'Task scheduler not available' })
        return
      }

      const taskId = await taskRuntime.triggerNow(id)
      if (!taskId) {
        res.status(500).json({ error: 'Failed to trigger cronjob' })
        return
      }

      res.json({ taskId, message: `Cronjob "${existing.name}" triggered successfully.` })
    } catch (err) {
      res.status(500).json({ error: `Failed to trigger cronjob: ${(err as Error).message}` })
    }
  })

  return router
}
