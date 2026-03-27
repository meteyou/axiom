import type { Database } from '@openagent/core'
import type { ConsolidationResult } from '@openagent/core'
import type { AgentCore } from '@openagent/core'
import {
  consolidateMemory,
  getActiveProvider,
  loadProvidersDecrypted,
  buildModel,
  getApiKeyForProvider,
  ensureConfigTemplates,
  loadConfig,
  logTokenUsage,
  estimateCost,
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

export interface ConsolidationSchedulerOptions {
  db: Database
  agentCore?: AgentCore | null
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
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private settings: ConsolidationSettings = { ...DEFAULT_CONSOLIDATION_SETTINGS }
  private lastRun: string | null = null
  private lastResult: ConsolidationResult | null = null
  private consolidationInFlight: Promise<ConsolidationResult> | null = null

  constructor(options: ConsolidationSchedulerOptions) {
    this.db = options.db
    this.agentCore = options.agentCore ?? null
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
        console.warn('[openagent] Memory consolidation skipped: no provider available')
        return result
      }

      const model = buildModel(provider)
      const apiKey = await getApiKeyForProvider(provider)

      const result = await consolidateMemory({
        lookbackDays: this.settings.lookbackDays,
        model,
        apiKey,
      })

      this.lastRun = new Date().toISOString()
      this.lastResult = result

      // Log token usage
      if (result.usage) {
        const cost = estimateCost(model, result.usage.input, result.usage.output)
        logTokenUsage(this.db, {
          provider: provider.provider,
          model: model.id,
          promptTokens: result.usage.input,
          completionTokens: result.usage.output,
          estimatedCost: cost,
          sessionId: 'memory-consolidation',
        })
      }

      // Refresh the agent's system prompt if memory was updated
      if (result.updated && this.agentCore) {
        try {
          this.agentCore.refreshSystemPrompt()
        } catch (err) {
          console.error('[openagent] Failed to refresh system prompt after consolidation:', err)
        }
      }

      console.log(
        `[openagent] Memory consolidation complete: ${result.updated ? 'UPDATED' : 'no change'} ` +
        `(${result.dailyFilesReviewed} daily files reviewed` +
        (result.usage ? `, ${result.usage.input + result.usage.output} tokens` : '') +
        `)`
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
      console.error('[openagent] Memory consolidation failed:', err)
      return result
    }
  }

  private resolveProvider() {
    const providerId = this.settings.providerId

    if (!providerId || providerId === 'default') {
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
