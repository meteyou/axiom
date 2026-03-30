import type { AgentTool } from '@mariozechner/pi-agent-core'
import { Type } from '@mariozechner/pi-ai'
import type { ScheduledTaskStore } from './scheduled-task-store.js'
import type { TaskScheduler } from './task-scheduler.js'
import { validateCronExpression, cronToHumanReadable, parseCronExpression, getNextRunTime } from './cron-parser.js'

export interface CronjobToolsOptions {
  scheduledTaskStore: ScheduledTaskStore
  taskScheduler: TaskScheduler
}

/**
 * Create the `create_cronjob` agent tool
 */
export function createCronjobTool(options: CronjobToolsOptions): AgentTool {
  return {
    name: 'create_cronjob',
    label: 'Create Cronjob',
    description:
      'Create a recurring scheduled task (cronjob). The task will run automatically on the given schedule. ' +
      'Convert the user\'s natural language schedule description into a standard cron expression (5 fields: minute hour day-of-month month day-of-week). ' +
      'Examples: "every day at 9:00" → "0 9 * * *", "every 15 minutes" → "*/15 * * * *", "weekdays at 14:30" → "30 14 * * 1-5".',
    parameters: Type.Object({
      prompt: Type.String({
        description: 'Detailed prompt describing what the cronjob should do on each run.',
      }),
      name: Type.String({
        description: 'Short, descriptive name for the cronjob (e.g., "Daily News Summary", "Hourly Health Check")',
      }),
      schedule: Type.String({
        description: 'Cron expression (5 fields: minute hour day-of-month month day-of-week). Example: "0 9 * * *" for every day at 9:00.',
      }),
      provider: Type.Optional(
        Type.String({
          description: 'Provider to use for this cronjob. Only specify if the user explicitly requests a specific provider.',
        })
      ),
    }),
    execute: async (_toolCallId, params) => {
      const { prompt, name, schedule, provider } = params as {
        prompt: string
        name: string
        schedule: string
        provider?: string
      }

      try {
        // Validate cron expression
        const validationError = validateCronExpression(schedule)
        if (validationError) {
          return {
            content: [{ type: 'text' as const, text: `Error: Invalid cron expression "${schedule}". ${validationError}` }],
            details: { error: true },
          }
        }

        // Create in DB
        const scheduledTask = options.scheduledTaskStore.create({
          name,
          prompt,
          schedule,
          provider: provider ?? undefined,
          enabled: true,
        })

        // Register with scheduler
        options.taskScheduler.registerSchedule(scheduledTask)

        const humanSchedule = cronToHumanReadable(schedule)

        return {
          content: [{
            type: 'text' as const,
            text: `Cronjob created successfully.\n\nID: ${scheduledTask.id}\nName: ${name}\nSchedule: ${humanSchedule} (${schedule})\n${provider ? `Provider: ${provider}\n` : ''}Status: Enabled\n\nThe cronjob is now active and will run on the specified schedule.`,
          }],
          details: {
            cronjobId: scheduledTask.id,
            name,
            schedule,
            humanSchedule,
            provider: provider ?? null,
          },
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: 'text' as const, text: `Error creating cronjob: ${errorMsg}` }],
          details: { error: true },
        }
      }
    },
  }
}

/**
 * Create the `edit_cronjob` agent tool
 */
export function editCronjobTool(options: CronjobToolsOptions): AgentTool {
  return {
    name: 'edit_cronjob',
    label: 'Edit Cronjob',
    description:
      'Edit an existing cronjob. You can update the prompt, name, schedule, provider, or enabled status. ' +
      'Only provide the fields you want to change.',
    parameters: Type.Object({
      id: Type.String({
        description: 'The ID of the cronjob to edit.',
      }),
      prompt: Type.Optional(
        Type.String({
          description: 'New prompt for the cronjob.',
        })
      ),
      name: Type.Optional(
        Type.String({
          description: 'New name for the cronjob.',
        })
      ),
      schedule: Type.Optional(
        Type.String({
          description: 'New cron expression (5 fields).',
        })
      ),
      provider: Type.Optional(
        Type.String({
          description: 'New provider for the cronjob.',
        })
      ),
      enabled: Type.Optional(
        Type.Boolean({
          description: 'Enable or disable the cronjob.',
        })
      ),
    }),
    execute: async (_toolCallId, params) => {
      const { id, prompt, name, schedule, provider, enabled } = params as {
        id: string
        prompt?: string
        name?: string
        schedule?: string
        provider?: string
        enabled?: boolean
      }

      try {
        // Check exists
        const existing = options.scheduledTaskStore.getById(id)
        if (!existing) {
          return {
            content: [{ type: 'text' as const, text: `Error: Cronjob "${id}" not found.` }],
            details: { error: true },
          }
        }

        // Validate schedule if provided
        if (schedule) {
          const validationError = validateCronExpression(schedule)
          if (validationError) {
            return {
              content: [{ type: 'text' as const, text: `Error: Invalid cron expression "${schedule}". ${validationError}` }],
              details: { error: true },
            }
          }
        }

        // Update in DB
        const updated = options.scheduledTaskStore.update(id, {
          prompt,
          name,
          schedule,
          provider,
          enabled,
        })

        if (!updated) {
          return {
            content: [{ type: 'text' as const, text: `Error: Failed to update cronjob "${id}".` }],
            details: { error: true },
          }
        }

        // Re-register with scheduler
        options.taskScheduler.registerSchedule(updated)

        const humanSchedule = cronToHumanReadable(updated.schedule)

        return {
          content: [{
            type: 'text' as const,
            text: `Cronjob updated successfully.\n\nID: ${updated.id}\nName: ${updated.name}\nSchedule: ${humanSchedule} (${updated.schedule})\nProvider: ${updated.provider ?? 'default'}\nStatus: ${updated.enabled ? 'Enabled' : 'Disabled'}`,
          }],
          details: {
            cronjobId: updated.id,
            name: updated.name,
            schedule: updated.schedule,
            humanSchedule,
            provider: updated.provider,
            enabled: updated.enabled,
          },
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: 'text' as const, text: `Error editing cronjob: ${errorMsg}` }],
          details: { error: true },
        }
      }
    },
  }
}

/**
 * Create the `remove_cronjob` agent tool
 */
export function removeCronjobTool(options: CronjobToolsOptions): AgentTool {
  return {
    name: 'remove_cronjob',
    label: 'Remove Cronjob',
    description: 'Delete an existing cronjob. This permanently removes the scheduled task.',
    parameters: Type.Object({
      id: Type.String({
        description: 'The ID of the cronjob to delete.',
      }),
    }),
    execute: async (_toolCallId, params) => {
      const { id } = params as { id: string }

      try {
        // Check exists
        const existing = options.scheduledTaskStore.getById(id)
        if (!existing) {
          return {
            content: [{ type: 'text' as const, text: `Error: Cronjob "${id}" not found.` }],
            details: { error: true },
          }
        }

        // Unregister from scheduler
        options.taskScheduler.unregisterSchedule(id)

        // Delete from DB
        const deleted = options.scheduledTaskStore.delete(id)
        if (!deleted) {
          return {
            content: [{ type: 'text' as const, text: `Error: Failed to delete cronjob "${id}".` }],
            details: { error: true },
          }
        }

        return {
          content: [{
            type: 'text' as const,
            text: `Cronjob "${existing.name}" (${id}) has been deleted.`,
          }],
          details: {
            cronjobId: id,
            name: existing.name,
            deleted: true,
          },
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: 'text' as const, text: `Error removing cronjob: ${errorMsg}` }],
          details: { error: true },
        }
      }
    },
  }
}

/**
 * Create the `list_cronjobs` agent tool
 */
export function listCronjobsTool(options: CronjobToolsOptions): AgentTool {
  return {
    name: 'list_cronjobs',
    label: 'List Cronjobs',
    description:
      'List all configured cronjobs with their schedules, status, and upcoming run times. ' +
      'Use this to answer questions like "which cronjobs are active?", "what runs tomorrow morning?", ' +
      'or "show me all scheduled tasks". Optionally compute the next N run times for each cronjob.',
    parameters: Type.Object({
      enabled_only: Type.Optional(
        Type.Boolean({
          description: 'If true, only show enabled cronjobs. Default: false (show all).',
        })
      ),
      next_runs: Type.Optional(
        Type.Number({
          description: 'Number of upcoming run times to compute for each cronjob (default: 3, max: 10).',
        })
      ),
    }),
    execute: async (_toolCallId, params) => {
      const { enabled_only, next_runs } = params as {
        enabled_only?: boolean
        next_runs?: number
      }

      try {
        const cronjobs = enabled_only
          ? options.scheduledTaskStore.listEnabled()
          : options.scheduledTaskStore.list()

        if (cronjobs.length === 0) {
          return {
            content: [{ type: 'text' as const, text: enabled_only
              ? 'No enabled cronjobs found.'
              : 'No cronjobs configured.'
            }],
            details: { count: 0 },
          }
        }

        const numRuns = Math.min(Math.max(next_runs ?? 3, 1), 10)
        const now = new Date()

        const lines = cronjobs.map(cj => {
          const humanSchedule = cronToHumanReadable(cj.schedule)
          const status = cj.enabled ? 'ENABLED' : 'DISABLED'

          // Compute next run times
          let nextRunsStr = ''
          if (cj.enabled) {
            try {
              const fields = parseCronExpression(cj.schedule)
              const runs: string[] = []
              let cursor = new Date(now.getTime() - 60000) // start from now
              for (let i = 0; i < numRuns; i++) {
                const next = getNextRunTime(fields, cursor)
                if (!next) break
                runs.push(next.toISOString().replace('T', ' ').slice(0, 16) + ' UTC')
                cursor = next
              }
              if (runs.length > 0) {
                nextRunsStr = `\n  Next runs: ${runs.join(', ')}` 
              }
            } catch {
              // Skip if cron parse fails
            }
          }

          const lastRun = cj.lastRunAt
            ? `${cj.lastRunStatus ?? 'unknown'} at ${cj.lastRunAt}`
            : 'never'

          return `\u2022 [${status}] ${cj.name}\n  ID: ${cj.id}\n  Schedule: ${humanSchedule} (${cj.schedule})\n  Provider: ${cj.provider ?? 'default'}\n  Last run: ${lastRun}${nextRunsStr}`
        })

        return {
          content: [{ type: 'text' as const, text: `Found ${cronjobs.length} cronjob(s):\n\n${lines.join('\n\n')}` }],
          details: { count: cronjobs.length },
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: 'text' as const, text: `Error listing cronjobs: ${errorMsg}` }],
          details: { error: true },
        }
      }
    },
  }
}
