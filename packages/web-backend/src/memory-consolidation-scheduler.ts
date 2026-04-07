import type { Database } from '@openagent/core'
import type { ConsolidationResult } from '@openagent/core'
import type { AgentCore } from '@openagent/core'
import type { TaskStore, Task } from '@openagent/core'
import type { TaskRunner } from '@openagent/core'
import type { ProviderConfig } from '@openagent/core'
import {
  getActiveProvider,
  loadProvidersDecrypted,
  ensureConfigTemplates,
  loadConfig,
  logToolCall,
  readConsolidationFile,
} from '@openagent/core'

export interface ConsolidationSettings {
  enabled: boolean
  /** Cron-like: run at this hour (0-23) in local time. Default: 3 (3 AM) */
  runAtHour: number
  /** Number of days of daily memory to review. Default: 3 */
  lookbackDays: number
  /** Provider ID to use. Empty string or 'default' = use active provider */
  providerId: string
}

export const DEFAULT_CONSOLIDATION_SETTINGS: ConsolidationSettings = {
  enabled: false,
  runAtHour: 3,
  lookbackDays: 3,
  providerId: '',
}

/**
 * Build the consolidation prompt that instructs the task agent what to do.
 * Embeds the user-defined consolidation rules from CONSOLIDATION.md directly.
 */
function buildConsolidationTaskPrompt(lookbackDays: number, consolidationRules: string): string {
  return `You are a nightly memory consolidation agent. Your job is to review recent daily memory files and decide what knowledge should be promoted to long-term memory, project notes, or user profiles.

## Consolidation Rules

${consolidationRules.trim()}

## Steps

1. **Read recent daily files**: Use \`list_files\` on the \`daily/\` directory, then \`read_file\` to read the last ${lookbackDays} days of daily files (files named YYYY-MM-DD.md, sorted by date). Skip files that only contain a header and no content.

2. **Read MEMORY.md**: Use \`read_file\` to read the current MEMORY.md. This is the long-term memory file.

3. **Read project notes**: Use \`list_files\` on the \`projects/\` directory, then \`read_file\` to read each project note. These contain per-project context.

4. **Read user profiles**: Use \`list_files\` on the \`users/\` directory, then \`read_file\` to read each user profile.

5. **Optionally read chat history**: If daily files reference conversations that need more detail, use \`read_chat_history\` to get the full context.

6. **Decide what to promote/update** (guided by the consolidation rules above):
   - If you find recurring patterns, learned lessons, or important facts in daily files, add them to MEMORY.md using \`edit_file\` or \`write_file\`.
   - If you find project-specific information, update the relevant project note in \`projects/\` or create a new one if a new project is detected.
   - If you find user-specific information (preferences, context), update the relevant user profile in \`users/\`.
   - Remove outdated or superseded information from MEMORY.md.
   - Do NOT duplicate information across files — each fact should live in exactly one place.

7. **Complete silently**: When done, finish with STATUS: silent. Only use STATUS: completed if you made significant changes that the user should know about.

## Important Rules

- All file paths are relative to the memory directory.
- Be conservative — only promote information that is clearly important or recurring.
- Do not remove information from daily files — they are append-only logs.
- If nothing needs updating, complete silently with no changes.
- Do NOT ask questions — make reasonable decisions autonomously.`
}

export interface ConsolidationSchedulerOptions {
  db: Database
  agentCore?: AgentCore | null
  taskStore?: TaskStore | null
  taskRunner?: TaskRunner | null
  getDefaultProvider?: () => ProviderConfig | null
}

export interface ConsolidationSnapshot {
  enabled: boolean
  runAtHour: number
  lookbackDays: number
  providerId: string
  lastRun: string | null
  lastResult: ConsolidationResult | null
  nextRunEstimate: string | null
}

export class MemoryConsolidationScheduler {
  private db: Database
  private agentCore: AgentCore | null
  private taskStore: TaskStore | null
  private taskRunner: TaskRunner | null
  private getDefaultProviderFn: (() => ProviderConfig | null) | null
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private settings: ConsolidationSettings = { ...DEFAULT_CONSOLIDATION_SETTINGS }
  private lastRun: string | null = null
  private lastResult: ConsolidationResult | null = null
  private consolidationInFlight: Promise<ConsolidationResult> | null = null

  constructor(options: ConsolidationSchedulerOptions) {
    this.db = options.db
    this.agentCore = options.agentCore ?? null
    this.taskStore = options.taskStore ?? null
    this.taskRunner = options.taskRunner ?? null
    this.getDefaultProviderFn = options.getDefaultProvider ?? null
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.settings = this.loadSettings()
    if (this.settings.enabled) {
      this.scheduleNext()
    }
  }

  stop(): void {
    this.running = false
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  restart(): void {
    this.stop()
    this.running = true
    this.settings = this.loadSettings()
    if (this.settings.enabled) {
      this.scheduleNext()
    }
  }

  /**
   * Run consolidation now (manual trigger or scheduled)
   */
  async runNow(): Promise<ConsolidationResult> {
    if (this.consolidationInFlight) {
      return this.consolidationInFlight
    }

    this.consolidationInFlight = this.executeConsolidation().finally(() => {
      this.consolidationInFlight = null
      if (this.running && this.settings.enabled) {
        this.scheduleNext()
      }
    })

    return this.consolidationInFlight
  }

  getSnapshot(): ConsolidationSnapshot {
    return {
      enabled: this.settings.enabled,
      runAtHour: this.settings.runAtHour,
      lookbackDays: this.settings.lookbackDays,
      providerId: this.settings.providerId,
      lastRun: this.lastRun,
      lastResult: this.lastResult,
      nextRunEstimate: this.settings.enabled ? this.getNextRunTime().toISOString() : null,
    }
  }

  /**
   * Update the agent core reference (e.g., when provider changes)
   */
  setAgentCore(agentCore: AgentCore | null): void {
    this.agentCore = agentCore
  }

  /**
   * Update the task store reference
   */
  setTaskStore(taskStore: TaskStore | null): void {
    this.taskStore = taskStore
  }

  /**
   * Update the task runner reference
   */
  setTaskRunner(taskRunner: TaskRunner | null): void {
    this.taskRunner = taskRunner
  }

  private scheduleNext(): void {
    if (!this.running || !this.settings.enabled) return

    if (this.timer) {
      clearTimeout(this.timer)
    }

    const nextRun = this.getNextRunTime()
    const delayMs = nextRun.getTime() - Date.now()

    this.timer = setTimeout(() => {
      void this.runNow()
    }, Math.max(0, delayMs))

    if (typeof this.timer === 'object' && 'unref' in this.timer) {
      this.timer.unref()
    }

    console.log(`[openagent] Memory consolidation scheduled for ${nextRun.toISOString()} (in ${Math.round(delayMs / 60000)} min)`)
  }

  private getNextRunTime(): Date {
    const now = new Date()
    const next = new Date(now)
    next.setHours(this.settings.runAtHour, 0, 0, 0)

    // If that time already passed today, schedule for tomorrow
    if (next.getTime() <= now.getTime()) {
      next.setDate(next.getDate() + 1)
    }

    return next
  }

  private async executeConsolidation(): Promise<ConsolidationResult> {
    console.log('[openagent] Starting memory consolidation...')
    const startTime = Date.now()
    const sessionId = `nightly-consolidation-${Date.now()}`

    // Ensure we have TaskStore and TaskRunner
    if (!this.taskStore || !this.taskRunner) {
      const result: ConsolidationResult = {
        updated: false,
        dailyFilesReviewed: 0,
        reason: 'TaskStore or TaskRunner not available for consolidation',
      }
      this.lastRun = new Date().toISOString()
      this.lastResult = result

      logToolCall(this.db, {
        sessionId,
        toolName: 'memory_consolidation',
        input: JSON.stringify({ lookbackDays: this.settings.lookbackDays }),
        output: JSON.stringify({ error: 'TaskStore or TaskRunner not available' }),
        durationMs: Date.now() - startTime,
        status: 'error',
      })

      console.warn('[openagent] Memory consolidation skipped: TaskStore or TaskRunner not available')
      return result
    }

    try {
      // Resolve the provider to use
      const provider = this.resolveProvider()
      if (!provider) {
        const result: ConsolidationResult = {
          updated: false,
          dailyFilesReviewed: 0,
          reason: 'No provider available for consolidation',
        }
        this.lastRun = new Date().toISOString()
        this.lastResult = result

        logToolCall(this.db, {
          sessionId,
          toolName: 'memory_consolidation',
          input: JSON.stringify({ lookbackDays: this.settings.lookbackDays }),
          output: JSON.stringify({ error: 'No provider available for consolidation' }),
          durationMs: Date.now() - startTime,
          status: 'error',
        })

        console.warn('[openagent] Memory consolidation skipped: no provider available')
        return result
      }

      // Read user-defined consolidation rules
      const consolidationRules = readConsolidationFile()

      // Create a task via TaskStore
      const prompt = buildConsolidationTaskPrompt(this.settings.lookbackDays, consolidationRules)
      const task: Task = this.taskStore.create({
        name: 'Nightly Memory Consolidation',
        prompt,
        triggerType: 'consolidation',
        triggerSourceId: 'memory-consolidation',
        provider: provider.name,
        model: provider.defaultModel,
        sessionId,
      })

      // Start the task via TaskRunner
      await this.taskRunner.startTask(task, provider)

      console.log(`[openagent] Memory consolidation task started: ${task.id}`)

      // Wait for the task to complete by polling
      const result = await this.waitForTaskCompletion(task.id, startTime, sessionId)

      this.lastRun = new Date().toISOString()
      this.lastResult = result

      // Refresh the agent's system prompt if memory files may have been modified
      if (this.agentCore) {
        try {
          this.agentCore.refreshSystemPrompt()
        } catch (err) {
          console.error('[openagent] Failed to refresh system prompt after consolidation:', err)
        }
      }

      // Log to activity log
      logToolCall(this.db, {
        sessionId,
        toolName: 'memory_consolidation',
        input: JSON.stringify({
          lookbackDays: this.settings.lookbackDays,
          provider: provider.provider,
          model: provider.defaultModel,
          taskId: task.id,
        }),
        output: JSON.stringify({
          updated: result.updated,
          dailyFilesReviewed: result.dailyFilesReviewed,
          reason: result.reason ?? null,
        }),
        durationMs: Date.now() - startTime,
        status: 'success',
      })

      console.log(
        `[openagent] Memory consolidation complete: ${result.updated ? 'UPDATED' : 'no change'} ` +
        `(task ${task.id}` +
        (result.usage ? `, ${result.usage.input + result.usage.output} tokens` : '') +
        `)`,
      )

      return result
    } catch (err) {
      const result: ConsolidationResult = {
        updated: false,
        dailyFilesReviewed: 0,
        reason: `Error: ${(err as Error).message}`,
      }
      this.lastRun = new Date().toISOString()
      this.lastResult = result

      // Log error to activity log
      logToolCall(this.db, {
        sessionId,
        toolName: 'memory_consolidation',
        input: JSON.stringify({
          lookbackDays: this.settings.lookbackDays,
        }),
        output: JSON.stringify({
          error: (err as Error).message,
        }),
        durationMs: Date.now() - startTime,
        status: 'error',
      })

      console.error('[openagent] Memory consolidation failed:', err)
      return result
    }
  }

  /**
   * Poll for task completion and build a ConsolidationResult from the finished task.
   */
  private async waitForTaskCompletion(
    taskId: string,
    startTime: number,
    sessionId: string,
  ): Promise<ConsolidationResult> {
    const POLL_INTERVAL_MS = 2000
    const MAX_WAIT_MS = 30 * 60 * 1000 // 30 minutes max

    return new Promise<ConsolidationResult>((resolve) => {
      const checkTask = () => {
        const task = this.taskStore!.getById(taskId)
        if (!task) {
          resolve({
            updated: false,
            dailyFilesReviewed: 0,
            reason: 'Task not found',
          })
          return
        }

        if (task.status === 'completed' || task.status === 'failed') {
          const totalTokens = task.promptTokens + task.completionTokens
          const updated = task.status === 'completed' && task.resultStatus !== 'silent'

          resolve({
            updated,
            dailyFilesReviewed: 0, // The task agent handles this internally
            reason: task.resultSummary ?? task.errorMessage ?? undefined,
            usage: totalTokens > 0 ? {
              input: task.promptTokens,
              output: task.completionTokens,
            } : undefined,
          })
          return
        }

        // Check if we've exceeded max wait time
        if (Date.now() - startTime > MAX_WAIT_MS) {
          resolve({
            updated: false,
            dailyFilesReviewed: 0,
            reason: 'Consolidation task timed out waiting for completion',
          })
          return
        }

        // Continue polling
        setTimeout(checkTask, POLL_INTERVAL_MS)
      }

      // Start polling
      setTimeout(checkTask, POLL_INTERVAL_MS)
    })
  }

  private resolveProvider(): ProviderConfig | null {
    const providerId = this.settings.providerId

    if (!providerId || providerId === 'default') {
      // Try the injected getDefaultProvider first, then fall back to getActiveProvider
      if (this.getDefaultProviderFn) {
        const provider = this.getDefaultProviderFn()
        if (provider) return provider
      }
      return getActiveProvider()
    }

    // Look up the specific provider
    const file = loadProvidersDecrypted()
    return file.providers.find(p => p.id === providerId) ?? getActiveProvider()
  }

  private loadSettings(): ConsolidationSettings {
    try {
      ensureConfigTemplates()
      const settings = loadConfig<{ memoryConsolidation?: Partial<ConsolidationSettings> }>('settings.json')
      return {
        ...DEFAULT_CONSOLIDATION_SETTINGS,
        ...(settings.memoryConsolidation ?? {}),
      }
    } catch {
      return { ...DEFAULT_CONSOLIDATION_SETTINGS }
    }
  }
}
