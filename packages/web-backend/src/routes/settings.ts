import { Router } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { getConfigDir, ensureConfigTemplates, loadConfig } from '@openagent/core'
import type { AgentCore } from '@openagent/core'
import { jwtMiddleware } from '../auth.js'
import type { AuthenticatedRequest } from '../auth.js'

export interface SettingsData {
  sessionTimeoutMinutes: number
  language: string
  heartbeatIntervalMinutes: number
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
  agentCore?: AgentCore | null
  onHeartbeatSettingsChanged?: () => void
  onConsolidationSettingsChanged?: () => void
}

export function createSettingsRouter(options: SettingsRouterOptions = {}): Router {
  const router = Router()
  const agentCore = options.agentCore ?? null

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

      res.json({
        sessionTimeoutMinutes: settings.sessionTimeoutMinutes ?? 15,
        language: settings.language ?? 'match',
        heartbeatIntervalMinutes: settings.heartbeatIntervalMinutes ?? 5,
        yoloMode: settings.yoloMode ?? true,
        batchingDelayMs: settings.batchingDelayMs ?? telegram.batchingDelayMs ?? 2500,
        telegramBotToken: telegram.botToken ?? '',
        memoryConsolidation: {
          enabled: consolidation?.enabled ?? false,
          runAtHour: consolidation?.runAtHour ?? 3,
          lookbackDays: consolidation?.lookbackDays ?? 3,
          providerId: consolidation?.providerId ?? '',
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
      heartbeatIntervalMinutes: number
      yoloMode: boolean
      batchingDelayMs: number
      telegramBotToken: string
      memoryConsolidation: Partial<MemoryConsolidationSettingsData>
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

      // Handle memory consolidation settings
      const settingsRaw = settings as unknown as Record<string, unknown>
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

      if (body.telegramBotToken !== undefined) {
        if (typeof body.telegramBotToken !== 'string') {
          res.status(400).json({ error: 'telegramBotToken must be a string' })
          return
        }
        telegram.botToken = body.telegramBotToken.trim()
      }

      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8')
      fs.writeFileSync(telegramPath, JSON.stringify(telegram, null, 2) + '\n', 'utf-8')

      if (agentCore) {
        try {
          if (body.sessionTimeoutMinutes !== undefined) {
            agentCore.getSessionManager().setTimeoutMinutes(settings.sessionTimeoutMinutes)
          }
          if (body.language !== undefined) {
            agentCore.refreshSystemPrompt()
          }
        } catch (err) {
          console.error('[openagent] Failed to apply live settings update:', err)
        }
      }

      if ((settings.heartbeatIntervalMinutes ?? 5) !== previousHeartbeatInterval) {
        options.onHeartbeatSettingsChanged?.()
      }

      if (consolidationChanged) {
        options.onConsolidationSettingsChanged?.()
      }

      const consolidationOut = (settingsRaw.memoryConsolidation ?? {}) as Record<string, unknown>

      res.json({
        message: 'Settings updated',
        sessionTimeoutMinutes: settings.sessionTimeoutMinutes,
        language: settings.language,
        heartbeatIntervalMinutes: settings.heartbeatIntervalMinutes,
        yoloMode: settings.yoloMode,
        batchingDelayMs: settings.batchingDelayMs ?? previousBatchingDelayMs,
        telegramBotToken: telegram.botToken,
        memoryConsolidation: {
          enabled: consolidationOut.enabled ?? false,
          runAtHour: consolidationOut.runAtHour ?? 3,
          lookbackDays: consolidationOut.lookbackDays ?? 3,
          providerId: consolidationOut.providerId ?? '',
        },
      })
    } catch (err) {
      res.status(500).json({ error: `Failed to update settings: ${(err as Error).message}` })
    }
  })

  return router
}
