import type { Database, ProviderConfig, ProviderHealthCheckResult, ProviderHealthStatus } from '@openagent/core'
import {
  getActiveProvider,
  performProviderHealthCheck,
  logHealthCheck,
  updateProviderStatus,
  ensureConfigTemplates,
  loadConfig,
} from '@openagent/core'

interface TelegramConfig {
  enabled: boolean
  botToken: string
  adminUserIds: number[]
}

export interface HeartbeatSnapshot {
  agentStatus: 'running' | 'stopped'
  intervalMinutes: number
  activeProvider: {
    id: string
    name: string
    type: string
    model: string
    status: ProviderHealthStatus
  } | null
  lastCheck: ProviderHealthCheckResult | null
}

export interface HeartbeatServiceOptions {
  db: Database
  fetchImpl?: typeof fetch
  now?: () => Date
}

export class HeartbeatService {
  private db: Database
  private fetchImpl: typeof fetch
  private now: () => Date
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private intervalMinutes = 5
  private lastCheck: ProviderHealthCheckResult | null = null
  private activeProviderId: string | null = null
  private checkInFlight: Promise<ProviderHealthCheckResult> | null = null

  constructor(options: HeartbeatServiceOptions) {
    this.db = options.db
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? (() => new Date())
    this.intervalMinutes = this.loadHeartbeatIntervalMinutes()
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.intervalMinutes = this.loadHeartbeatIntervalMinutes()
    this.scheduleNext(0)
  }

  stop(): void {
    this.running = false
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  restart(options: { resetState?: boolean } = {}): void {
    if (options.resetState) {
      this.lastCheck = null
      this.activeProviderId = null
    }

    this.intervalMinutes = this.loadHeartbeatIntervalMinutes()

    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }

    if (this.running) {
      this.scheduleNext(0)
    }
  }

  async runNow(): Promise<ProviderHealthCheckResult> {
    if (this.checkInFlight) {
      return this.checkInFlight
    }

    this.checkInFlight = this.executeCheck().finally(() => {
      this.checkInFlight = null
      if (this.running) {
        this.scheduleNext(this.intervalMinutes * 60 * 1000)
      }
    })

    return this.checkInFlight
  }

  getSnapshot(): HeartbeatSnapshot {
    const provider = getActiveProvider()
    return {
      agentStatus: this.running ? 'running' : 'stopped',
      intervalMinutes: this.intervalMinutes,
      activeProvider: provider
        ? {
            id: provider.id,
            name: provider.name,
            type: provider.providerType,
            model: provider.defaultModel,
            status: this.lastCheck?.providerId === provider.id
              ? this.lastCheck.status
              : 'unconfigured',
          }
        : null,
      lastCheck: this.lastCheck,
    }
  }

  private scheduleNext(delayMs: number): void {
    if (!this.running) return

    if (this.timer) {
      clearTimeout(this.timer)
    }

    this.timer = setTimeout(() => {
      void this.runNow()
    }, Math.max(0, delayMs))

    if (typeof this.timer === 'object' && 'unref' in this.timer) {
      this.timer.unref()
    }
  }

  private async executeCheck(): Promise<ProviderHealthCheckResult> {
    const provider = getActiveProvider()

    if (provider?.id !== this.activeProviderId) {
      this.activeProviderId = provider?.id ?? null
      this.lastCheck = null
    }

    const previousStatus = this.lastCheck?.status ?? null
    const result = await performProviderHealthCheck(provider, {
      fetchImpl: this.fetchImpl,
    })

    result.checkedAt = this.now().toISOString()

    logHealthCheck(this.db, {
      timestamp: result.checkedAt,
      provider: result.providerName,
      status: result.status,
      latencyMs: result.latencyMs,
      errorMessage: result.errorMessage,
    })

    if (provider) {
      updateProviderStatus(provider.id, result.status === 'down' ? 'error' : 'connected')
    }

    const shouldNotifyDown = result.status === 'down' && previousStatus !== 'down'
    const shouldNotifyRecovery = previousStatus === 'down' && result.status === 'healthy'

    this.lastCheck = result

    if (shouldNotifyDown) {
      await this.sendTelegramAlert('down', provider, result)
    } else if (shouldNotifyRecovery) {
      await this.sendTelegramAlert('recovery', provider, result)
    }

    return result
  }

  private loadHeartbeatIntervalMinutes(): number {
    try {
      ensureConfigTemplates()
      const settings = loadConfig<{ heartbeatIntervalMinutes?: number }>('settings.json')
      const value = settings.heartbeatIntervalMinutes ?? 5
      return Number.isFinite(value) && value >= 1 ? value : 5
    } catch {
      return 5
    }
  }

  private loadTelegramConfig(): TelegramConfig | null {
    try {
      ensureConfigTemplates()
      const config = loadConfig<TelegramConfig>('telegram.json')
      return config
    } catch {
      return null
    }
  }

  private getAdminTelegramIds(): number[] {
    const config = this.loadTelegramConfig()
    const configuredIds = config?.adminUserIds ?? []
    const dbIds = (this.db.prepare(
      `SELECT telegram_id
       FROM users
       WHERE role = 'admin' AND telegram_id IS NOT NULL AND trim(telegram_id) != ''`
    ).all() as Array<{ telegram_id: string }>).map((row) => Number.parseInt(row.telegram_id, 10))

    return Array.from(new Set([...configuredIds, ...dbIds].filter((id) => Number.isFinite(id))))
  }

  private async sendTelegramAlert(
    kind: 'down' | 'recovery',
    provider: ProviderConfig | null,
    result: ProviderHealthCheckResult,
  ): Promise<void> {
    const telegram = this.loadTelegramConfig()
    if (!telegram?.enabled || !telegram.botToken) {
      return
    }

    const adminIds = this.getAdminTelegramIds()
    if (adminIds.length === 0) {
      return
    }

    const title = kind === 'down' ? '🚨 OpenAgent provider is down' : '✅ OpenAgent provider recovered'
    const lines = [
      title,
      `Provider: ${provider?.name ?? 'Not configured'}`,
      `Model: ${provider?.defaultModel ?? '—'}`,
      `Status: ${result.status}`,
      `Checked at: ${result.checkedAt}`,
    ]

    if (result.latencyMs !== null) {
      lines.push(`Latency: ${result.latencyMs}ms`)
    }

    if (result.errorMessage) {
      lines.push(`Error: ${result.errorMessage}`)
    }

    const text = lines.join('\n')

    await Promise.all(adminIds.map(async (chatId) => {
      try {
        const response = await this.fetchImpl(`https://api.telegram.org/bot${telegram.botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text }),
        })

        if (!response.ok) {
          const body = await response.text().catch(() => '')
          console.error(`[openagent] Failed to send Telegram heartbeat alert to ${chatId}: ${response.status} ${body}`)
        }
      } catch (err) {
        console.error(`[openagent] Failed to send Telegram heartbeat alert to ${chatId}:`, err)
      }
    }))
  }
}
