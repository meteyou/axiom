import { Router } from 'express'
import type { Database } from '@openagent/core'
import { ScheduledTaskStore, validateCronExpression, cronToHumanReadable } from '@openagent/core'
import type { TaskScheduler } from '@openagent/core'
import { jwtMiddleware } from '../auth.js'
import type { AuthenticatedRequest } from '../auth.js'

export interface CronjobsRouterOptions {
  db: Database
  getTaskScheduler?: () => TaskScheduler | null
}

export function createCronjobsRouter(options: CronjobsRouterOptions): Router {
  const router = Router()
  const store = new ScheduledTaskStore(options.db)

  router.use(jwtMiddleware)

  /**
   * GET /api/cronjobs
   * Returns all scheduled tasks
   */
  router.get('/', (_req: AuthenticatedRequest, res) => {
    try {
      const cronjobs = store.list()

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
      const { name, prompt, schedule, provider, enabled } = req.body as {
        name?: string
        prompt?: string
        schedule?: string
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

      const cronjob = store.create({
        name,
        prompt,
        schedule,
        provider: provider || undefined,
        enabled: enabled !== undefined ? enabled : true,
      })

      // Register with scheduler
      const scheduler = options.getTaskScheduler?.()
      if (scheduler) {
        scheduler.registerSchedule(cronjob)
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
      const existing = store.getById(id)
      if (!existing) {
        res.status(404).json({ error: 'Cronjob not found' })
        return
      }

      const { name, prompt, schedule, provider, enabled } = req.body as {
        name?: string
        prompt?: string
        schedule?: string
        provider?: string
        enabled?: boolean
      }

      // Validate cron expression if provided
      if (schedule) {
        const validationError = validateCronExpression(schedule)
        if (validationError) {
          res.status(400).json({ error: `Invalid cron expression: ${validationError}` })
          return
        }
      }

      const updated = store.update(id, {
        name,
        prompt,
        schedule,
        provider,
        enabled,
      })

      if (!updated) {
        res.status(500).json({ error: 'Failed to update cronjob' })
        return
      }

      // Re-register with scheduler
      const scheduler = options.getTaskScheduler?.()
      if (scheduler) {
        scheduler.registerSchedule(updated)
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
      const existing = store.getById(id)
      if (!existing) {
        res.status(404).json({ error: 'Cronjob not found' })
        return
      }

      // Unregister from scheduler
      const scheduler = options.getTaskScheduler?.()
      if (scheduler) {
        scheduler.unregisterSchedule(id)
      }

      const deleted = store.delete(id)
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
      const existing = store.getById(id)
      if (!existing) {
        res.status(404).json({ error: 'Cronjob not found' })
        return
      }

      const scheduler = options.getTaskScheduler?.()
      if (!scheduler) {
        res.status(503).json({ error: 'Task scheduler not available' })
        return
      }

      const taskId = await scheduler.triggerNow(id)
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
