import { Router } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { getConfigDir, ensureConfigTemplates, loadConfig } from '@openagent/core'
import type { AgentCore } from '@openagent/core'
import { jwtMiddleware } from '../auth.js'
import type { AuthenticatedRequest } from '../auth.js'

export interface HeartbeatNotificationToggles {
  healthyToDegraded: boolean
  degradedToHealthy: boolean
  degradedToDown: boolean
  healthyToDown: boolean
  downToFallback: boolean
  fallbackToHealthy: boolean
}

export interface HeartbeatData {
  intervalMinutes?: number
  fallbackTrigger?: 'down' | 'degraded'
  failuresBeforeFallback?: number
  recoveryCheckIntervalMinutes?: number
  successesBeforeRecovery?: number
  notifications?: Partial<HeartbeatNotificationToggles>
}

export interface SettingsData {
  sessionTimeoutMinutes: number
  language: string
  timezone: string
  heartbeatIntervalMinutes: number
  heartbeat?: HeartbeatData
  batchingDelayMs?: number
  yoloMode: boolean
}

export interface TelegramData {
  enabled: boolean
  botToken: string
  adminUserIds: number[]
  pollingMode: boolean
  webhookUrl: string
  batchingDelayMs?: number
}

export interface MemoryConsolidationSettingsData {
  enabled: boolean
  runAtHour: number
  lookbackDays: number
  providerId: string
}

export interface SettingsRouterOptions {
  getAgentCore?: () => AgentCore | null
  onHeartbeatSettingsChanged?: () => void
  onConsolidationSettingsChanged?: () => void
  onTelegramSettingsChanged?: () => void
}

export function createSettingsRouter(options: SettingsRouterOptions = {}): Router {
  const router = Router()
  const getAgentCore = options.getAgentCore ?? (() => null)

  router.use(jwtMiddleware)
  router.use((req: AuthenticatedRequest, res, next) => {
    if (req.user?.role !== 'admin') {
      res.status(403).json({ error: 'Admin access required' })
      return
    }
    next()
  })

  router.get('/', (_req, res) => {
    try {
      ensureConfigTemplates()
      const settings = loadConfig<SettingsData>('settings.json')
      const telegram = loadConfig<TelegramData>('telegram.json')

      const consolidation = (settings as unknown as Record<string, unknown>).memoryConsolidation as Partial<MemoryConsolidationSettingsData> | undefined
      const tasks = (settings as unknown as Record<string, unknown>).tasks as {
        defaultProvider?: string
        maxDurationMinutes?: number
        telegramDelivery?: string
        loopDetection?: {
          enabled?: boolean
          method?: string
          maxConsecutiveFailures?: number
          smartProvider?: string
          smartCheckInterval?: number
        }
        statusUpdateIntervalMinutes?: number
      } | undefined

      const defaultNotifications: HeartbeatNotificationToggles = {
        healthyToDegraded: false,
        degradedToHealthy: false,
        degradedToDown: true,
        healthyToDown: true,
        downToFallback: true,
        fallbackToHealthy: true,
      }

      res.json({
        sessionTimeoutMinutes: settings.sessionTimeoutMinutes ?? 15,
        language: settings.language ?? 'match',
        timezone: settings.timezone ?? 'UTC',
        heartbeatIntervalMinutes: settings.heartbeatIntervalMinutes ?? settings.heartbeat?.intervalMinutes ?? 5,
        yoloMode: settings.yoloMode ?? true,
        batchingDelayMs: settings.batchingDelayMs ?? telegram.batchingDelayMs ?? 2500,
        telegramEnabled: telegram.enabled ?? false,
        telegramBotToken: telegram.botToken ?? '',
        heartbeat: {
          fallbackTrigger: settings.heartbeat?.fallbackTrigger ?? 'down',
          failuresBeforeFallback: settings.heartbeat?.failuresBeforeFallback ?? 1,
          recoveryCheckIntervalMinutes: settings.heartbeat?.recoveryCheckIntervalMinutes ?? 1,
          successesBeforeRecovery: settings.heartbeat?.successesBeforeRecovery ?? 3,
          notifications: { ...defaultNotifications, ...settings.heartbeat?.notifications },
        },
        memoryConsolidation: {
          enabled: consolidation?.enabled ?? false,
          runAtHour: consolidation?.runAtHour ?? 3,
          lookbackDays: consolidation?.lookbackDays ?? 3,
          providerId: consolidation?.providerId ?? '',
        },
        tasks: {
          defaultProvider: tasks?.defaultProvider ?? '',
          maxDurationMinutes: tasks?.maxDurationMinutes ?? 60,
          telegramDelivery: tasks?.telegramDelivery ?? 'auto',
          loopDetection: {
            enabled: tasks?.loopDetection?.enabled ?? true,
            method: tasks?.loopDetection?.method ?? 'systematic',
            maxConsecutiveFailures: tasks?.loopDetection?.maxConsecutiveFailures ?? 3,
            smartProvider: tasks?.loopDetection?.smartProvider ?? '',
            smartCheckInterval: tasks?.loopDetection?.smartCheckInterval ?? 5,
          },
          statusUpdateIntervalMinutes: tasks?.statusUpdateIntervalMinutes ?? 10,
        },
      })
    } catch (err) {
      res.status(500).json({ error: `Failed to read settings: ${(err as Error).message}` })
    }
  })

  router.put('/', (req: AuthenticatedRequest, res) => {
    const body = req.body as Partial<{
      sessionTimeoutMinutes: number
      language: string
      timezone: string
      heartbeatIntervalMinutes: number
      yoloMode: boolean
      batchingDelayMs: number
      telegramEnabled: boolean
      telegramBotToken: string
      heartbeat: {
        fallbackTrigger?: 'down' | 'degraded'
        failuresBeforeFallback?: number
        recoveryCheckIntervalMinutes?: number
        successesBeforeRecovery?: number
        notifications?: Partial<HeartbeatNotificationToggles>
      }
      memoryConsolidation: Partial<MemoryConsolidationSettingsData>
      tasks: Partial<{
        defaultProvider: string
        maxDurationMinutes: number
        telegramDelivery: string
        loopDetection: Partial<{
          enabled: boolean
          method: string
          maxConsecutiveFailures: number
          smartProvider: string
          smartCheckInterval: number
        }>
        statusUpdateIntervalMinutes: number
      }>
    }>

    try {
      ensureConfigTemplates()
      const configDir = getConfigDir()
      const settingsPath = path.join(configDir, 'settings.json')
      const telegramPath = path.join(configDir, 'telegram.json')

      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as SettingsData
      const telegram = JSON.parse(fs.readFileSync(telegramPath, 'utf-8')) as TelegramData
      const previousHeartbeatInterval = settings.heartbeatIntervalMinutes ?? 5
      const previousBatchingDelayMs = settings.batchingDelayMs ?? telegram.batchingDelayMs ?? 2500
      const previousTelegramEnabled = telegram.enabled
      const previousTelegramBotToken = telegram.botToken

      if (body.sessionTimeoutMinutes !== undefined) {
        if (typeof body.sessionTimeoutMinutes !== 'number' || !Number.isFinite(body.sessionTimeoutMinutes) || body.sessionTimeoutMinutes < 1) {
          res.status(400).json({ error: 'sessionTimeoutMinutes must be a positive number' })
          return
        }
        settings.sessionTimeoutMinutes = body.sessionTimeoutMinutes
      }

      if (body.language !== undefined) {
        if (typeof body.language !== 'string' || !body.language.trim()) {
          res.status(400).json({ error: 'language must be a non-empty string' })
          return
        }
        settings.language = body.language.trim()
      }

      if (body.timezone !== undefined) {
        if (typeof body.timezone !== 'string' || !body.timezone.trim()) {
          res.status(400).json({ error: 'timezone must be a non-empty string' })
          return
        }
        settings.timezone = body.timezone.trim()
      }

      if (body.heartbeatIntervalMinutes !== undefined) {
        if (typeof body.heartbeatIntervalMinutes !== 'number' || !Number.isFinite(body.heartbeatIntervalMinutes) || body.heartbeatIntervalMinutes < 1) {
          res.status(400).json({ error: 'heartbeatIntervalMinutes must be a positive number' })
          return
        }
        settings.heartbeatIntervalMinutes = body.heartbeatIntervalMinutes
      }

      if (body.yoloMode !== undefined) {
        settings.yoloMode = !!body.yoloMode
      }

      if (body.batchingDelayMs !== undefined) {
        if (typeof body.batchingDelayMs !== 'number' || !Number.isFinite(body.batchingDelayMs) || body.batchingDelayMs < 0) {
          res.status(400).json({ error: 'batchingDelayMs must be a non-negative number' })
          return
        }
        settings.batchingDelayMs = body.batchingDelayMs
      }

      // Handle heartbeat notification settings
      const settingsRaw = settings as unknown as Record<string, unknown>
      let heartbeatChanged = false
      if (body.heartbeat !== undefined) {
        const existingHeartbeat = (settingsRaw.heartbeat ?? {}) as Record<string, unknown>

        if (body.heartbeat.fallbackTrigger !== undefined) {
          if (!['down', 'degraded'].includes(body.heartbeat.fallbackTrigger)) {
            res.status(400).json({ error: 'heartbeat.fallbackTrigger must be "down" or "degraded"' })
            return
          }
          existingHeartbeat.fallbackTrigger = body.heartbeat.fallbackTrigger
          heartbeatChanged = true
        }
        if (body.heartbeat.failuresBeforeFallback !== undefined) {
          if (typeof body.heartbeat.failuresBeforeFallback !== 'number' || !Number.isFinite(body.heartbeat.failuresBeforeFallback) || body.heartbeat.failuresBeforeFallback < 1) {
            res.status(400).json({ error: 'heartbeat.failuresBeforeFallback must be a number >= 1' })
            return
          }
          existingHeartbeat.failuresBeforeFallback = body.heartbeat.failuresBeforeFallback
          heartbeatChanged = true
        }
        if (body.heartbeat.recoveryCheckIntervalMinutes !== undefined) {
          if (typeof body.heartbeat.recoveryCheckIntervalMinutes !== 'number' || !Number.isFinite(body.heartbeat.recoveryCheckIntervalMinutes) || body.heartbeat.recoveryCheckIntervalMinutes < 1) {
            res.status(400).json({ error: 'heartbeat.recoveryCheckIntervalMinutes must be a number >= 1' })
            return
          }
          existingHeartbeat.recoveryCheckIntervalMinutes = body.heartbeat.recoveryCheckIntervalMinutes
          heartbeatChanged = true
        }
        if (body.heartbeat.successesBeforeRecovery !== undefined) {
          if (typeof body.heartbeat.successesBeforeRecovery !== 'number' || !Number.isFinite(body.heartbeat.successesBeforeRecovery) || body.heartbeat.successesBeforeRecovery < 1) {
            res.status(400).json({ error: 'heartbeat.successesBeforeRecovery must be a number >= 1' })
            return
          }
          existingHeartbeat.successesBeforeRecovery = body.heartbeat.successesBeforeRecovery
          heartbeatChanged = true
        }

        if (body.heartbeat.notifications !== undefined) {
          const existingNotifications = (existingHeartbeat.notifications ?? {}) as Record<string, unknown>
          const incoming = body.heartbeat.notifications
          for (const key of ['healthyToDegraded', 'degradedToHealthy', 'degradedToDown', 'healthyToDown', 'downToFallback', 'fallbackToHealthy'] as const) {
            if (incoming[key] !== undefined) {
              existingNotifications[key] = !!incoming[key]
            }
          }
          existingHeartbeat.notifications = existingNotifications
          heartbeatChanged = true
        }

        settingsRaw.heartbeat = existingHeartbeat
      }

      // Handle memory consolidation settings
      let consolidationChanged = false
      if (body.memoryConsolidation !== undefined) {
        const mc = body.memoryConsolidation
        const existing = (settingsRaw.memoryConsolidation ?? {}) as Record<string, unknown>

        if (mc.enabled !== undefined) existing.enabled = !!mc.enabled
        if (mc.runAtHour !== undefined) {
          if (typeof mc.runAtHour !== 'number' || !Number.isInteger(mc.runAtHour) || mc.runAtHour < 0 || mc.runAtHour > 23) {
            res.status(400).json({ error: 'memoryConsolidation.runAtHour must be an integer 0-23' })
            return
          }
          existing.runAtHour = mc.runAtHour
        }
        if (mc.lookbackDays !== undefined) {
          if (typeof mc.lookbackDays !== 'number' || !Number.isInteger(mc.lookbackDays) || mc.lookbackDays < 1 || mc.lookbackDays > 30) {
            res.status(400).json({ error: 'memoryConsolidation.lookbackDays must be an integer 1-30' })
            return
          }
          existing.lookbackDays = mc.lookbackDays
        }
        if (mc.providerId !== undefined) {
          if (typeof mc.providerId !== 'string') {
            res.status(400).json({ error: 'memoryConsolidation.providerId must be a string' })
            return
          }
          existing.providerId = mc.providerId
        }

        settingsRaw.memoryConsolidation = existing
        consolidationChanged = true
      }

      // Handle tasks settings
      if (body.tasks !== undefined) {
        const existingTasks = (settingsRaw.tasks ?? {}) as Record<string, unknown>

        if (body.tasks.defaultProvider !== undefined) {
          if (typeof body.tasks.defaultProvider !== 'string') {
            res.status(400).json({ error: 'tasks.defaultProvider must be a string' })
            return
          }
          existingTasks.defaultProvider = body.tasks.defaultProvider
        }
        if (body.tasks.maxDurationMinutes !== undefined) {
          if (typeof body.tasks.maxDurationMinutes !== 'number' || !Number.isFinite(body.tasks.maxDurationMinutes) || body.tasks.maxDurationMinutes < 1) {
            res.status(400).json({ error: 'tasks.maxDurationMinutes must be a positive number' })
            return
          }
          existingTasks.maxDurationMinutes = body.tasks.maxDurationMinutes
        }
        if (body.tasks.telegramDelivery !== undefined) {
          if (!['auto', 'always'].includes(body.tasks.telegramDelivery)) {
            res.status(400).json({ error: 'tasks.telegramDelivery must be "auto" or "always"' })
            return
          }
          existingTasks.telegramDelivery = body.tasks.telegramDelivery
        }

        // Loop detection settings
        if (body.tasks.loopDetection !== undefined) {
          const existingLd = (existingTasks.loopDetection ?? {}) as Record<string, unknown>
          const ld = body.tasks.loopDetection

          if (ld.enabled !== undefined) existingLd.enabled = !!ld.enabled
          if (ld.method !== undefined) {
            if (!['systematic', 'smart', 'auto'].includes(ld.method)) {
              res.status(400).json({ error: 'tasks.loopDetection.method must be "systematic", "smart", or "auto"' })
              return
            }
            existingLd.method = ld.method
          }
          if (ld.maxConsecutiveFailures !== undefined) {
            if (typeof ld.maxConsecutiveFailures !== 'number' || !Number.isFinite(ld.maxConsecutiveFailures) || ld.maxConsecutiveFailures < 1) {
              res.status(400).json({ error: 'tasks.loopDetection.maxConsecutiveFailures must be a positive number' })
              return
            }
            existingLd.maxConsecutiveFailures = ld.maxConsecutiveFailures
          }
          if (ld.smartProvider !== undefined) {
            if (typeof ld.smartProvider !== 'string') {
              res.status(400).json({ error: 'tasks.loopDetection.smartProvider must be a string' })
              return
            }
            existingLd.smartProvider = ld.smartProvider
          }
          if (ld.smartCheckInterval !== undefined) {
            if (typeof ld.smartCheckInterval !== 'number' || !Number.isFinite(ld.smartCheckInterval) || ld.smartCheckInterval < 1) {
              res.status(400).json({ error: 'tasks.loopDetection.smartCheckInterval must be a positive number' })
              return
            }
            existingLd.smartCheckInterval = ld.smartCheckInterval
          }

          existingTasks.loopDetection = existingLd
        }

        // Status update interval
        if (body.tasks.statusUpdateIntervalMinutes !== undefined) {
          if (typeof body.tasks.statusUpdateIntervalMinutes !== 'number' || !Number.isFinite(body.tasks.statusUpdateIntervalMinutes) || body.tasks.statusUpdateIntervalMinutes < 1) {
            res.status(400).json({ error: 'tasks.statusUpdateIntervalMinutes must be a positive number' })
            return
          }
          existingTasks.statusUpdateIntervalMinutes = body.tasks.statusUpdateIntervalMinutes
        }

        settingsRaw.tasks = existingTasks
      }

      if (body.telegramEnabled !== undefined) {
        telegram.enabled = !!body.telegramEnabled
      }

      if (body.telegramBotToken !== undefined) {
        if (typeof body.telegramBotToken !== 'string') {
          res.status(400).json({ error: 'telegramBotToken must be a string' })
          return
        }
        telegram.botToken = body.telegramBotToken.trim()
      }

      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8')
      fs.writeFileSync(telegramPath, JSON.stringify(telegram, null, 2) + '\n', 'utf-8')

      const agentCore = getAgentCore()
      if (agentCore) {
        try {
          if (body.sessionTimeoutMinutes !== undefined) {
            agentCore.getSessionManager().setTimeoutMinutes(settings.sessionTimeoutMinutes)
          }
          if (body.language !== undefined || body.timezone !== undefined) {
            agentCore.refreshSystemPrompt()
          }
        } catch (err) {
          console.error('[openagent] Failed to apply live settings update:', err)
        }
      }

      if ((settings.heartbeatIntervalMinutes ?? 5) !== previousHeartbeatInterval || heartbeatChanged) {
        options.onHeartbeatSettingsChanged?.()
      }

      if (consolidationChanged) {
        options.onConsolidationSettingsChanged?.()
      }

      if (telegram.enabled !== previousTelegramEnabled || telegram.botToken !== previousTelegramBotToken) {
        options.onTelegramSettingsChanged?.()
      }

      const tasksOut = (settingsRaw.tasks ?? {}) as Record<string, unknown>
      const consolidationOut = (settingsRaw.memoryConsolidation ?? {}) as Record<string, unknown>

      const defaultNotifications: HeartbeatNotificationToggles = {
        healthyToDegraded: false,
        degradedToHealthy: false,
        degradedToDown: true,
        healthyToDown: true,
        downToFallback: true,
        fallbackToHealthy: true,
      }
      const heartbeatOut = (settingsRaw.heartbeat ?? {}) as Record<string, unknown>
      const notificationsOut = (heartbeatOut.notifications ?? {}) as Record<string, unknown>

      res.json({
        message: 'Settings updated',
        sessionTimeoutMinutes: settings.sessionTimeoutMinutes,
        language: settings.language,
        timezone: settings.timezone ?? 'UTC',
        heartbeatIntervalMinutes: settings.heartbeatIntervalMinutes,
        yoloMode: settings.yoloMode,
        batchingDelayMs: settings.batchingDelayMs ?? previousBatchingDelayMs,
        telegramEnabled: telegram.enabled,
        telegramBotToken: telegram.botToken,
        heartbeat: {
          fallbackTrigger: heartbeatOut.fallbackTrigger ?? 'down',
          failuresBeforeFallback: heartbeatOut.failuresBeforeFallback ?? 1,
          recoveryCheckIntervalMinutes: heartbeatOut.recoveryCheckIntervalMinutes ?? 1,
          successesBeforeRecovery: heartbeatOut.successesBeforeRecovery ?? 3,
          notifications: { ...defaultNotifications, ...notificationsOut },
        },
        memoryConsolidation: {
          enabled: consolidationOut.enabled ?? false,
          runAtHour: consolidationOut.runAtHour ?? 3,
          lookbackDays: consolidationOut.lookbackDays ?? 3,
          providerId: consolidationOut.providerId ?? '',
        },
        tasks: {
          defaultProvider: tasksOut.defaultProvider ?? '',
          maxDurationMinutes: tasksOut.maxDurationMinutes ?? 60,
          telegramDelivery: tasksOut.telegramDelivery ?? 'auto',
          loopDetection: {
            enabled: (tasksOut.loopDetection as Record<string, unknown>)?.enabled ?? true,
            method: (tasksOut.loopDetection as Record<string, unknown>)?.method ?? 'systematic',
            maxConsecutiveFailures: (tasksOut.loopDetection as Record<string, unknown>)?.maxConsecutiveFailures ?? 3,
            smartProvider: (tasksOut.loopDetection as Record<string, unknown>)?.smartProvider ?? '',
            smartCheckInterval: (tasksOut.loopDetection as Record<string, unknown>)?.smartCheckInterval ?? 5,
          },
          statusUpdateIntervalMinutes: tasksOut.statusUpdateIntervalMinutes ?? 10,
        },
      })
    } catch (err) {
      res.status(500).json({ error: `Failed to update settings: ${(err as Error).message}` })
    }
  })

  return router
}
