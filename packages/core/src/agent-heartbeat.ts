import fs from 'node:fs'
import path from 'node:path'
import { ensureConfigTemplates, getDefaultTimezone, loadConfig } from './config.js'
import type { Database } from './database.js'
import { getBootstrapAdminId, resolveUserScope } from './user-scope.js'
import type { UserScope } from './user-scope.js'
import type { Task } from './task-store.js'
import type { ProviderConfig } from './provider-config.js'
import { getProviderDefaultModel } from './provider-config.js'
import type { TaskRuntimeTaskBoundary } from './task-runtime.js'

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

function buildHeartbeatPrompt(heartbeatFile: string): string {
  return `Read ${heartbeatFile}. Execute the tasks defined there.
If you have something important to report to the user, use task injection.
If nothing needs attention, complete silently.`
}

/**
 * A user's own switch. Unset means: the bootstrap admin follows the legacy
 * global `enabled` flag, everyone else is off.
 */
export function isUserHeartbeatEnabled(db: Database, userId: number, globalEnabled: boolean): boolean {
  const row = db.prepare('SELECT heartbeat_enabled FROM users WHERE id = ?').get(userId) as { heartbeat_enabled: number | null } | undefined
  if (!row) return false
  if (row.heartbeat_enabled !== null && row.heartbeat_enabled !== undefined) return row.heartbeat_enabled === 1
  return userId === getBootstrapAdminId(db) && globalEnabled
}

export function setUserHeartbeatEnabled(db: Database, userId: number, enabled: boolean): void {
  db.prepare("UPDATE users SET heartbeat_enabled = ?, updated_at = datetime('now') WHERE id = ?").run(enabled ? 1 : 0, userId)
}

export function readUserHeartbeat(scope: UserScope, fallback: string): string {
  try {
    return fs.readFileSync(scope.paths.heartbeatFile, 'utf-8')
  } catch {
    return fallback
  }
}

export function writeUserHeartbeat(scope: UserScope, content: string): void {
  fs.mkdirSync(path.dirname(scope.paths.heartbeatFile), { recursive: true })
  fs.writeFileSync(scope.paths.heartbeatFile, content, 'utf-8')
}

type HeartbeatTaskRuntime = Pick<TaskRuntimeTaskBoundary, 'create' | 'start'>

export interface AgentHeartbeatServiceOptions {
  taskRuntime: HeartbeatTaskRuntime
  /** Enables per-user heartbeats; without it a single legacy heartbeat runs. */
  db?: Database
  getDefaultProvider: () => ProviderConfig | null
  /** Override for testing — returns the current time */
  now?: () => Date
  /** Override for testing — returns the configured timezone */
  getTimezone?: () => string
}

/**
 * Returns true if the HEARTBEAT.md content contains only blank lines,
 * ATX headings (`# ...`), and empty checkbox list items (`- [ ]`).
 * Any other content is considered "actionable".
 */
export function isHeartbeatContentEffectivelyEmpty(content: string): boolean {
  const lines = content.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    if (/^#{1,6}\s/.test(trimmed) || /^#{1,6}$/.test(trimmed)) continue
    if (/^-\s*\[\s*\]\s*$/.test(trimmed)) continue
    if (/^<!--.*-->$/.test(trimmed)) continue
    return false
  }
  return true
}

export function loadAgentHeartbeatSettings(): AgentHeartbeatSettings {
  try {
    ensureConfigTemplates()
    const config = loadConfig<{ agentHeartbeat?: Partial<AgentHeartbeatSettings & { nightMode?: Partial<AgentHeartbeatNightMode> }> }>('settings.json')
    const raw = config.agentHeartbeat

    if (!raw) return { ...DEFAULT_AGENT_HEARTBEAT_SETTINGS }

    return {
      enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_AGENT_HEARTBEAT_SETTINGS.enabled,
      intervalMinutes: safePositiveInt(raw.intervalMinutes, DEFAULT_AGENT_HEARTBEAT_SETTINGS.intervalMinutes),
      nightMode: {
        enabled: typeof raw.nightMode?.enabled === 'boolean' ? raw.nightMode.enabled : DEFAULT_AGENT_HEARTBEAT_SETTINGS.nightMode.enabled,
        startHour: safeHour(raw.nightMode?.startHour, DEFAULT_AGENT_HEARTBEAT_SETTINGS.nightMode.startHour),
        endHour: safeHour(raw.nightMode?.endHour, DEFAULT_AGENT_HEARTBEAT_SETTINGS.nightMode.endHour),
      },
    }
  } catch {
    return { ...DEFAULT_AGENT_HEARTBEAT_SETTINGS }
  }
}

function safePositiveInt(value: number | undefined, defaultValue: number): number {
  if (value === undefined) return defaultValue
  return Number.isFinite(value) && Number.isInteger(value) && value >= 1 ? value : defaultValue
}

function safeHour(value: number | undefined, defaultValue: number): number {
  if (value === undefined) return defaultValue
  return Number.isFinite(value) && Number.isInteger(value) && value >= 0 && value <= 23 ? value : defaultValue
}

export class AgentHeartbeatService {
  private taskRuntime: HeartbeatTaskRuntime
  private db: Database | null
  private getDefaultProvider: () => ProviderConfig | null
  private nowFn: () => Date
  private getTimezoneFn: () => string
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private settings: AgentHeartbeatSettings = { ...DEFAULT_AGENT_HEARTBEAT_SETTINGS }

  constructor(options: AgentHeartbeatServiceOptions) {
    if (!options.taskRuntime) {
      throw new Error('AgentHeartbeatService requires taskRuntime')
    }

    this.taskRuntime = options.taskRuntime
    this.db = options.db ?? null
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

  /** Runs one tick and returns the id of the first task it started, or null. */
  async executeHeartbeat(): Promise<string | null> {
    return (await this.executeHeartbeatTick())[0] ?? null
  }

  /**
   * One tick: a heartbeat task per eligible user (switch on, actionable
   * file, outside the user's night mode). Without a database, the single
   * legacy heartbeat runs.
   */
  async executeHeartbeatTick(): Promise<string[]> {
    if (!this.db) {
      const legacyFile = path.join(process.env.DATA_DIR ?? '/data', 'config', 'HEARTBEAT.md')
      const id = await this.runHeartbeat(null, legacyFile, this.getTimezoneFn())
      return id ? [id] : []
    }

    const rows = this.db.prepare('SELECT id FROM users WHERE deleted_at IS NULL ORDER BY id').all() as Array<{ id: number }>
    const taskIds: string[] = []
    for (const row of rows) {
      if (!isUserHeartbeatEnabled(this.db, row.id, this.settings.enabled)) continue
      const scope = resolveUserScope(this.db, row.id)
      if (!scope) continue
      const id = await this.runHeartbeat(scope.id, scope.paths.heartbeatFile, scope.settings.timezone)
      if (id) taskIds.push(id)
    }
    return taskIds
  }

  private async runHeartbeat(ownerUserId: number | null, heartbeatFile: string, timezone: string): Promise<string | null> {
    const label = ownerUserId === null ? '' : ` (user ${ownerUserId})`
    if (this.isNightMode(undefined, timezone)) {
      console.log(`[axiom] Agent heartbeat skipped${label}: night mode active`)
      return null
    }

    try {
      const content = fs.readFileSync(heartbeatFile, 'utf-8')
      if (isHeartbeatContentEffectivelyEmpty(content)) {
        console.log(`[axiom] Agent heartbeat skipped${label}: HEARTBEAT.md has no actionable content`)
        return null
      }
    } catch {
      console.log(`[axiom] Agent heartbeat skipped${label}: HEARTBEAT.md not found or unreadable`)
      return null
    }

    const provider = this.getDefaultProvider()
    if (!provider) {
      console.warn('[axiom] Agent heartbeat skipped: no provider available')
      return null
    }

    // The TaskRunner creates the session (type='heartbeat') when the task starts.
    const task: Task = this.taskRuntime.create({
      name: 'Agent Heartbeat',
      prompt: buildHeartbeatPrompt(heartbeatFile),
      triggerType: 'heartbeat',
      triggerSourceId: 'agent-heartbeat',
      provider: provider.name,
      model: getProviderDefaultModel(provider),
      isDefaultModel: true,
      ...(ownerUserId !== null ? { ownerUserId } : {}),
    })

    try {
      await this.taskRuntime.start(task, provider)
      console.log(`[axiom] Agent heartbeat task started${label}: ${task.id}`)
      return task.id
    } catch (err) {
      console.error(`[axiom] Agent heartbeat task failed to start${label}:`, err)
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
      void this.executeHeartbeatTick().finally(() => {
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
    return loadAgentHeartbeatSettings()
  }

  private loadTimezone(): string {
    try {
      ensureConfigTemplates()
      const config = loadConfig<{ timezone?: string }>('settings.json')
      return config.timezone || getDefaultTimezone()
    } catch {
      return getDefaultTimezone()
    }
  }
}
