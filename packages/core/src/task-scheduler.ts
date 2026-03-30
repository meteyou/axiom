import type { Database } from './database.js'
import { ScheduledTaskStore } from './scheduled-task-store.js'
import type { ScheduledTask } from './scheduled-task-store.js'
import type { TaskStore } from './task-store.js'
import type { TaskRunner } from './task-runner.js'
import type { TaskOverrides } from './task-runner.js'
import type { ProviderConfig } from './provider-config.js'
import { parseCronExpression, getNextRunTime } from './cron-parser.js'

export interface TaskSchedulerOptions {
  db: Database
  taskStore: TaskStore
  taskRunner: TaskRunner
  /** Get the default provider for tasks */
  getDefaultProvider: () => ProviderConfig
  /** Resolve a provider by name/id */
  resolveProvider: (nameOrId: string) => ProviderConfig | null
  /** Callback for injection-type cronjobs — injects a message into the main agent */
  onInjection?: (scheduledTaskId: string, injection: string) => void
}

interface ScheduleEntry {
  scheduledTaskId: string
  timer: ReturnType<typeof setTimeout>
  nextRunTime: Date
}

/**
 * Task Scheduler — loads cron-based scheduled tasks and fires them via TaskRunner.
 *
 * Similar pattern to MemoryConsolidationScheduler but generalized for N schedules.
 */
export class TaskScheduler {
  private scheduledTaskStore: ScheduledTaskStore
  private taskStore: TaskStore
  private taskRunner: TaskRunner
  private options: TaskSchedulerOptions
  private schedules: Map<string, ScheduleEntry> = new Map()
  private running = false

  constructor(options: TaskSchedulerOptions) {
    this.options = options
    this.scheduledTaskStore = new ScheduledTaskStore(options.db)
    this.taskStore = options.taskStore
    this.taskRunner = options.taskRunner
  }

  /**
   * Get the underlying ScheduledTaskStore
   */
  getStore(): ScheduledTaskStore {
    return this.scheduledTaskStore
  }

  /**
   * Start the scheduler — loads all enabled schedules and sets timers
   */
  start(): void {
    if (this.running) return
    this.running = true
    this.loadAllSchedules()
  }

  /**
   * Stop the scheduler — clears all timers
   */
  stop(): void {
    this.running = false
    for (const [, entry] of this.schedules) {
      clearTimeout(entry.timer)
    }
    this.schedules.clear()
  }

  /**
   * Restart the scheduler
   */
  restart(): void {
    this.stop()
    this.start()
  }

  /**
   * Register or re-register a schedule (after create/update)
   */
  registerSchedule(scheduledTask: ScheduledTask): void {
    // Remove existing timer if any
    this.unregisterSchedule(scheduledTask.id)

    if (!scheduledTask.enabled || !this.running) return

    this.setNextTimer(scheduledTask)
  }

  /**
   * Unregister a schedule (after delete or disable)
   */
  unregisterSchedule(id: string): void {
    const entry = this.schedules.get(id)
    if (entry) {
      clearTimeout(entry.timer)
      this.schedules.delete(id)
    }
  }

  /**
   * Manually trigger a cronjob (run it immediately)
   */
  async triggerNow(scheduledTaskId: string): Promise<string | null> {
    const scheduledTask = this.scheduledTaskStore.getById(scheduledTaskId)
    if (!scheduledTask) return null

    if (scheduledTask.actionType === 'injection') {
      this.fireInjection(scheduledTask)
      return `injection-${scheduledTask.id}`
    }

    return this.fireTask(scheduledTask)
  }

  /**
   * Get info about all active schedules
   */
  getActiveSchedules(): Array<{ id: string; nextRunTime: Date }> {
    return Array.from(this.schedules.entries()).map(([id, entry]) => ({
      id,
      nextRunTime: entry.nextRunTime,
    }))
  }

  /**
   * Load all enabled schedules from DB and set timers
   */
  private loadAllSchedules(): void {
    const enabledTasks = this.scheduledTaskStore.listEnabled()
    for (const task of enabledTasks) {
      this.setNextTimer(task)
    }
    console.log(`[openagent] Task scheduler loaded ${enabledTasks.length} enabled schedule(s)`)
  }

  /** Minimum cooldown between firings of the same cronjob (in ms) */
  private static readonly FIRE_COOLDOWN_MS = 55_000 // 55 seconds — prevents double-firing within the same cron minute

  /**
   * Check whether a cronjob was already fired recently (deduplication guard).
   * Protects against double-firing caused by server restarts, watch-mode reloads, etc.
   */
  private wasFiredRecently(scheduledTask: ScheduledTask): boolean {
    if (!scheduledTask.lastRunAt) return false
    try {
      const lastRun = new Date(scheduledTask.lastRunAt.replace(' ', 'T') + 'Z').getTime()
      return (Date.now() - lastRun) < TaskScheduler.FIRE_COOLDOWN_MS
    } catch {
      return false
    }
  }

  /**
   * Calculate next run time and set a timer for a scheduled task
   */
  private setNextTimer(scheduledTask: ScheduledTask): void {
    try {
      const fields = parseCronExpression(scheduledTask.schedule)
      const nextRun = getNextRunTime(fields)

      if (!nextRun) {
        console.warn(`[openagent] Could not calculate next run time for schedule "${scheduledTask.name}" (${scheduledTask.schedule})`)
        return
      }

      const delayMs = nextRun.getTime() - Date.now()

      // Guard: if the next run is in the past (e.g. server restart after the
      // scheduled time), skip it rather than firing immediately.
      if (delayMs < -5_000) {
        console.log(`[openagent] Skipping past-due schedule "${scheduledTask.name}" (was due ${Math.round(-delayMs / 60000)} min ago)`)
        return
      }

      const timer = setTimeout(() => {
        this.onCronFired(scheduledTask.id)
      }, Math.max(0, delayMs))

      // Don't keep the process alive for timers
      if (typeof timer === 'object' && 'unref' in timer) {
        timer.unref()
      }

      this.schedules.set(scheduledTask.id, {
        scheduledTaskId: scheduledTask.id,
        timer,
        nextRunTime: nextRun,
      })

      console.log(`[openagent] Scheduled "${scheduledTask.name}" next run at ${nextRun.toISOString()} (in ${Math.round(delayMs / 60000)} min)`)
    } catch (err) {
      console.error(`[openagent] Failed to schedule "${scheduledTask.name}":`, (err as Error).message)
    }
  }

  /**
   * Called when a cron timer fires
   */
  private async onCronFired(scheduledTaskId: string): Promise<void> {
    // Remove the old timer entry
    this.schedules.delete(scheduledTaskId)

    // Re-read from DB (may have been updated/disabled)
    const scheduledTask = this.scheduledTaskStore.getById(scheduledTaskId)
    if (!scheduledTask || !scheduledTask.enabled) return

    // Deduplication guard: skip if this cronjob already fired very recently
    // (protects against double-fire from server restarts / watch-mode reloads)
    if (this.wasFiredRecently(scheduledTask)) {
      console.log(`[openagent] Skipping cronjob "${scheduledTask.name}" — already fired recently (lastRunAt: ${scheduledTask.lastRunAt})`)
      // Still schedule the next run
      if (this.running) {
        this.setNextTimer(scheduledTask)
      }
      return
    }

    try {
      if (scheduledTask.actionType === 'injection') {
        this.fireInjection(scheduledTask)
        console.log(`[openagent] Cronjob "${scheduledTask.name}" fired → injection`)
      } else {
        const taskId = await this.fireTask(scheduledTask)
        if (taskId) {
          console.log(`[openagent] Cronjob "${scheduledTask.name}" fired → task ${taskId}`)
        }
      }
    } catch (err) {
      console.error(`[openagent] Cronjob "${scheduledTask.name}" failed to fire:`, (err as Error).message)
    }

    // Schedule the next run (if still enabled and running)
    if (this.running) {
      const refreshed = this.scheduledTaskStore.getById(scheduledTaskId)
      if (refreshed && refreshed.enabled) {
        this.setNextTimer(refreshed)
      }
    }
  }

  /**
   * Fire an injection — send the prompt directly into the main agent
   */
  private fireInjection(scheduledTask: ScheduledTask): void {
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19)

    // Build the injection message
    const injection = `<scheduled_reminder cronjob_id="${scheduledTask.id}" cronjob_name="${scheduledTask.name}">
${scheduledTask.prompt}
</scheduled_reminder>`

    // Update last_run fields
    this.scheduledTaskStore.update(scheduledTask.id, {
      lastRunAt: now,
      lastRunStatus: 'completed',
    })

    // Deliver via callback
    if (this.options.onInjection) {
      this.options.onInjection(scheduledTask.id, injection)
    } else {
      console.warn(`[openagent] Injection cronjob "${scheduledTask.name}" fired but no onInjection handler is set`)
    }
  }

  /**
   * Fire a scheduled task — create a task via TaskRunner
   */
  private async fireTask(scheduledTask: ScheduledTask): Promise<string | null> {
    // Resolve provider
    let provider: ProviderConfig
    if (scheduledTask.provider) {
      const resolved = this.options.resolveProvider(scheduledTask.provider)
      provider = resolved ?? this.options.getDefaultProvider()
    } else {
      provider = this.options.getDefaultProvider()
    }

    // Create task in the task store
    const task = this.taskStore.create({
      name: scheduledTask.name,
      prompt: scheduledTask.prompt,
      triggerType: 'cronjob',
      triggerSourceId: scheduledTask.id,
      provider: provider.name,
      model: provider.defaultModel,
      sessionId: `cronjob-${scheduledTask.id}-${Date.now()}`,
    })

    // Update last_run_at on the scheduled task
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19)
    this.scheduledTaskStore.update(scheduledTask.id, {
      lastRunAt: now,
      lastRunTaskId: task.id,
      lastRunStatus: 'running',
    })

    // Build overrides from scheduled task
    const overrides: TaskOverrides = {
      toolsOverride: scheduledTask.toolsOverride,
      skillsOverride: scheduledTask.skillsOverride,
      systemPromptOverride: scheduledTask.systemPromptOverride,
    }

    // Start the task
    try {
      await this.taskRunner.startTask(task, provider, overrides)

      // Subscribe to task completion to update last_run_status
      this.watchTaskCompletion(scheduledTask.id, task.id)

      return task.id
    } catch (err) {
      // Update status to failed
      this.scheduledTaskStore.update(scheduledTask.id, {
        lastRunStatus: 'failed',
      })
      throw err
    }
  }

  /**
   * Poll for task completion to update the scheduled task's last_run_status
   */
  private watchTaskCompletion(scheduledTaskId: string, taskId: string): void {
    const checkInterval = setInterval(() => {
      const task = this.taskStore.getById(taskId)
      if (!task) {
        clearInterval(checkInterval)
        return
      }

      if (task.status === 'completed' || task.status === 'failed') {
        this.scheduledTaskStore.update(scheduledTaskId, {
          lastRunStatus: task.status,
        })
        clearInterval(checkInterval)
      }
    }, 5000) // Check every 5 seconds

    // Don't keep the process alive
    if (typeof checkInterval === 'object' && 'unref' in checkInterval) {
      checkInterval.unref()
    }
  }

  /**
   * Dispose the scheduler
   */
  dispose(): void {
    this.stop()
  }
}
