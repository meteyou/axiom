import { ensureConfigTemplates, loadConfig } from './config.js'
import type { TaskStore, Task } from './task-store.js'
import type { TaskRunner } from './task-runner.js'
import type { ProviderConfig } from './provider-config.js'

export interface AgentHeartbeatNightMode {
  enabled: boolean
  startHour: number
  endHour: number
}

export interface AgentHeartbeatSettings {
  enabled: boolean
  intervalMinutes: number
  nightMode: AgentHeartbeatNightMode
}

export const DEFAULT_AGENT_HEARTBEAT_SETTINGS: AgentHeartbeatSettings = {
  enabled: false,
  intervalMinutes: 60,
  nightMode: {
    enabled: true,
    startHour: 23,
    endHour: 8,
  },
}

const HEARTBEAT_PROMPT = `You are running a periodic heartbeat maintenance cycle.

1. Read \`/data/memory/HEARTBEAT.md\` for the list of tasks to execute.
2. For the "Daily Memory Update" task: read recent chat messages from the database, extract important facts, decisions, and preferences that haven't been captured yet, and write them to today's daily memory file (\`/data/memory/daily/YYYY-MM-DD.md\`). Focus on lasting value — skip ephemeral chatter.
3. For the "Memory Hygiene" task: check MEMORY.md for outdated entries and promote important insights from daily memory if needed.
4. Execute any other tasks defined in HEARTBEAT.md.

Use read_file and write_file to work with memory files.
If you have something important to report to the user, use task injection.
If nothing needs attention, complete silently without output.
Be efficient — avoid unnecessary LLM calls or tool usage.`

export interface AgentHeartbeatServiceOptions {
  taskStore: TaskStore
  taskRunner: TaskRunner
  getDefaultProvider: () => ProviderConfig
  /** Override for testing — returns the current time */
  now?: () => Date
  /** Override for testing — returns the configured timezone */
  getTimezone?: () => string
}

export class AgentHeartbeatService {
  private taskStore: TaskStore
  private taskRunner: TaskRunner
  private getDefaultProvider: () => ProviderConfig
  private nowFn: () => Date
  private getTimezoneFn: () => string
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private settings: AgentHeartbeatSettings = { ...DEFAULT_AGENT_HEARTBEAT_SETTINGS }

  constructor(options: AgentHeartbeatServiceOptions) {
    this.taskStore = options.taskStore
    this.taskRunner = options.taskRunner
    this.getDefaultProvider = options.getDefaultProvider
    this.nowFn = options.now ?? (() => new Date())
    this.getTimezoneFn = options.getTimezone ?? (() => this.loadTimezone())
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

  getSettings(): AgentHeartbeatSettings {
    return { ...this.settings }
  }

  /**
   * Check if the current time falls within the night mode window.
   * Handles midnight-crossing correctly (e.g. startHour=23, endHour=8 means 23:00→08:00 is night).
   */
  isNightMode(
    now?: Date,
    timezone?: string,
    settings?: AgentHeartbeatSettings,
  ): boolean {
    const s = settings ?? this.settings
    if (!s.nightMode.enabled) return false

    const currentTime = now ?? this.nowFn()
    const tz = timezone ?? this.getTimezoneFn()

    // Get the current hour in the configured timezone
    let currentHour: number
    try {
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hour: 'numeric',
        hour12: false,
      })
      currentHour = parseInt(formatter.format(currentTime), 10)
      // Intl can return 24 for midnight in some locales
      if (currentHour === 24) currentHour = 0
    } catch {
      // Fallback to UTC if timezone is invalid
      currentHour = currentTime.getUTCHours()
    }

    const { startHour, endHour } = s.nightMode

    if (startHour <= endHour) {
      // Non-crossing: e.g. 8→17 means hours 8,9,...,16 are night
      return currentHour >= startHour && currentHour < endHour
    } else {
      // Midnight-crossing: e.g. 23→8 means hours 23,0,1,...,7 are night
      return currentHour >= startHour || currentHour < endHour
    }
  }

  /**
   * Execute the heartbeat: create a background task that reads HEARTBEAT.md
   */
  async executeHeartbeat(): Promise<string | null> {
    // Check night mode
    if (this.isNightMode()) {
      console.log('[openagent] Agent heartbeat skipped: night mode active')
      return null
    }

    const provider = this.getDefaultProvider()
    if (!provider) {
      console.warn('[openagent] Agent heartbeat skipped: no provider available')
      return null
    }

    // Create a task
    const task: Task = this.taskStore.create({
      name: 'Agent Heartbeat',
      prompt: HEARTBEAT_PROMPT,
      triggerType: 'agent',
      triggerSourceId: 'agent-heartbeat',
      provider: provider.name,
      model: provider.defaultModel,
      sessionId: `agent-heartbeat-${Date.now()}`,
    })

    try {
      await this.taskRunner.startTask(task, provider)
      console.log(`[openagent] Agent heartbeat task started: ${task.id}`)
      return task.id
    } catch (err) {
      console.error('[openagent] Agent heartbeat task failed to start:', err)
      return null
    }
  }

  private scheduleNext(): void {
    if (!this.running || !this.settings.enabled) return

    if (this.timer) {
      clearTimeout(this.timer)
    }

    const intervalMs = this.settings.intervalMinutes * 60 * 1000

    this.timer = setTimeout(() => {
      void this.executeHeartbeat().finally(() => {
        if (this.running && this.settings.enabled) {
          this.scheduleNext()
        }
      })
    }, intervalMs)

    if (typeof this.timer === 'object' && 'unref' in this.timer) {
      this.timer.unref()
    }
  }

  private loadSettings(): AgentHeartbeatSettings {
    try {
      ensureConfigTemplates()
      const config = loadConfig<{ agentHeartbeat?: Partial<AgentHeartbeatSettings & { nightMode?: Partial<AgentHeartbeatNightMode> }> }>('settings.json')
      const raw = config.agentHeartbeat

      if (!raw) return { ...DEFAULT_AGENT_HEARTBEAT_SETTINGS }

      return {
        enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_AGENT_HEARTBEAT_SETTINGS.enabled,
        intervalMinutes: this.safePositiveInt(raw.intervalMinutes, DEFAULT_AGENT_HEARTBEAT_SETTINGS.intervalMinutes),
        nightMode: {
          enabled: typeof raw.nightMode?.enabled === 'boolean' ? raw.nightMode.enabled : DEFAULT_AGENT_HEARTBEAT_SETTINGS.nightMode.enabled,
          startHour: this.safeHour(raw.nightMode?.startHour, DEFAULT_AGENT_HEARTBEAT_SETTINGS.nightMode.startHour),
          endHour: this.safeHour(raw.nightMode?.endHour, DEFAULT_AGENT_HEARTBEAT_SETTINGS.nightMode.endHour),
        },
      }
    } catch {
      return { ...DEFAULT_AGENT_HEARTBEAT_SETTINGS }
    }
  }

  private loadTimezone(): string {
    try {
      ensureConfigTemplates()
      const config = loadConfig<{ timezone?: string }>('settings.json')
      return config.timezone || 'UTC'
    } catch {
      return 'UTC'
    }
  }

  private safePositiveInt(value: number | undefined, defaultValue: number): number {
    if (value === undefined) return defaultValue
    return Number.isFinite(value) && Number.isInteger(value) && value >= 1 ? value : defaultValue
  }

  private safeHour(value: number | undefined, defaultValue: number): number {
    if (value === undefined) return defaultValue
    return Number.isFinite(value) && Number.isInteger(value) && value >= 0 && value <= 23 ? value : defaultValue
  }
}
