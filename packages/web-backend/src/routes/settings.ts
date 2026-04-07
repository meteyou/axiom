import { Router } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { getConfigDir, ensureConfigTemplates, loadConfig } from '@openagent/core'
import type { AgentCore } from '@openagent/core'
import { jwtMiddleware } from '../auth.js'
import type { AuthenticatedRequest } from '../auth.js'

export interface HealthMonitorNotificationToggles {
  healthyToDegraded: boolean
  degradedToHealthy: boolean
  degradedToDown: boolean
  healthyToDown: boolean
  downToFallback: boolean
  fallbackToHealthy: boolean
}

export interface HealthMonitorData {
  intervalMinutes?: number
  fallbackTrigger?: 'down' | 'degraded'
  failuresBeforeFallback?: number
  recoveryCheckIntervalMinutes?: number
  successesBeforeRecovery?: number
  notifications?: Partial<HealthMonitorNotificationToggles>
}

export interface SettingsData {
  sessionTimeoutMinutes: number
  language: string
  timezone: string
  healthMonitorIntervalMinutes: number
  healthMonitor?: HealthMonitorData
  batchingDelayMs?: number
  uploadRetentionDays?: number
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

export interface AgentHeartbeatSettingsData {
  enabled: boolean
  intervalMinutes: number
  nightMode: {
    enabled: boolean
    startHour: number
    endHour: number
  }
}

export interface SettingsRouterOptions {
  getAgentCore?: () => AgentCore | null
  onHealthMonitorSettingsChanged?: () => void
  onConsolidationSettingsChanged?: () => void
  onAgentHeartbeatSettingsChanged?: () => void
  onTelegramSettingsChanged?: () => void
}

// ── Validation helpers ────────────────────────────────────────────────
// Each returns an error string on failure, or null on success.
// On success it mutates the target object in place.

function validatePositiveNumber(value: unknown, name: string): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    return `${name} must be a positive number`
  }
  return null
}

function validateNonNegativeNumber(value: unknown, name: string): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return `${name} must be a non-negative number`
  }
  return null
}

function validateHour(value: unknown, name: string): string | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 23) {
    return `${name} must be an integer 0-23`
  }
  return null
}

function validateNonEmptyString(value: unknown, name: string): string | null {
  if (typeof value !== 'string' || !value.trim()) {
    return `${name} must be a non-empty string`
  }
  return null
}

function validateEnum(value: unknown, allowed: string[], name: string): string | null {
  if (!allowed.includes(value as string)) {
    return `${name} must be ${allowed.map(a => `"${a}"`).join(' or ')}`
  }
  return null
}

// ── Per-group merge functions ─────────────────────────────────────────
// Each validates + merges incoming body fields into the raw settings object.
// Returns an error string on validation failure, or null on success.

function mergeHealthMonitor(
  body: Record<string, unknown>,
  settingsRaw: Record<string, unknown>,
): { error: string | null; changed: boolean } {
  const incoming = body.healthMonitor as Record<string, unknown> | undefined
  if (!incoming) return { error: null, changed: false }

  const existing = (settingsRaw.healthMonitor ?? {}) as Record<string, unknown>
  let changed = false

  if (incoming.fallbackTrigger !== undefined) {
    const err = validateEnum(incoming.fallbackTrigger, ['down', 'degraded'], 'healthMonitor.fallbackTrigger')
    if (err) return { error: err, changed }
    existing.fallbackTrigger = incoming.fallbackTrigger
    changed = true
  }
  for (const key of ['failuresBeforeFallback', 'recoveryCheckIntervalMinutes', 'successesBeforeRecovery'] as const) {
    if (incoming[key] !== undefined) {
      const err = validatePositiveNumber(incoming[key], `healthMonitor.${key}`)
      if (err) return { error: err, changed }
      existing[key] = incoming[key]
      changed = true
    }
  }
  if (incoming.notifications !== undefined) {
    const existingNotifications = (existing.notifications ?? {}) as Record<string, unknown>
    const incomingNotifications = incoming.notifications as Record<string, unknown>
    for (const key of ['healthyToDegraded', 'degradedToHealthy', 'degradedToDown', 'healthyToDown', 'downToFallback', 'fallbackToHealthy']) {
      if (incomingNotifications[key] !== undefined) {
        existingNotifications[key] = !!incomingNotifications[key]
      }
    }
    existing.notifications = existingNotifications
    changed = true
  }

  settingsRaw.healthMonitor = existing
  return { error: null, changed }
}

function mergeConsolidation(
  body: Record<string, unknown>,
  settingsRaw: Record<string, unknown>,
): { error: string | null; changed: boolean } {
  const mc = body.memoryConsolidation as Record<string, unknown> | undefined
  if (!mc) return { error: null, changed: false }

  const existing = (settingsRaw.memoryConsolidation ?? {}) as Record<string, unknown>

  if (mc.enabled !== undefined) existing.enabled = !!mc.enabled
  if (mc.runAtHour !== undefined) {
    const err = validateHour(mc.runAtHour, 'memoryConsolidation.runAtHour')
    if (err) return { error: err, changed: false }
    existing.runAtHour = mc.runAtHour
  }
  if (mc.lookbackDays !== undefined) {
    if (typeof mc.lookbackDays !== 'number' || !Number.isInteger(mc.lookbackDays) || mc.lookbackDays < 1 || mc.lookbackDays > 30) {
      return { error: 'memoryConsolidation.lookbackDays must be an integer 1-30', changed: false }
    }
    existing.lookbackDays = mc.lookbackDays
  }
  if (mc.providerId !== undefined) {
    if (typeof mc.providerId !== 'string') {
      return { error: 'memoryConsolidation.providerId must be a string', changed: false }
    }
    existing.providerId = mc.providerId
  }

  settingsRaw.memoryConsolidation = existing
  return { error: null, changed: true }
}

function mergeAgentHeartbeat(
  body: Record<string, unknown>,
  settingsRaw: Record<string, unknown>,
): { error: string | null; changed: boolean } {
  const ah = body.agentHeartbeat as Record<string, unknown> | undefined
  if (!ah) return { error: null, changed: false }

  const existing = (settingsRaw.agentHeartbeat ?? {}) as Record<string, unknown>

  if (ah.enabled !== undefined) existing.enabled = !!ah.enabled
  if (ah.intervalMinutes !== undefined) {
    const err = validatePositiveNumber(ah.intervalMinutes, 'agentHeartbeat.intervalMinutes')
    if (err) return { error: err, changed: false }
    existing.intervalMinutes = ah.intervalMinutes
  }
  if (ah.nightMode !== undefined) {
    const nm = ah.nightMode as Record<string, unknown>
    const existingNm = (existing.nightMode ?? {}) as Record<string, unknown>
    if (nm.enabled !== undefined) existingNm.enabled = !!nm.enabled
    if (nm.startHour !== undefined) {
      const err = validateHour(nm.startHour, 'agentHeartbeat.nightMode.startHour')
      if (err) return { error: err, changed: false }
      existingNm.startHour = nm.startHour
    }
    if (nm.endHour !== undefined) {
      const err = validateHour(nm.endHour, 'agentHeartbeat.nightMode.endHour')
      if (err) return { error: err, changed: false }
      existingNm.endHour = nm.endHour
    }
    existing.nightMode = existingNm
  }

  settingsRaw.agentHeartbeat = existing
  return { error: null, changed: true }
}

function mergeTts(
  body: Record<string, unknown>,
  settingsRaw: Record<string, unknown>,
): { error: string | null } {
  const tts = body.tts as Record<string, unknown> | undefined
  if (!tts) return { error: null }

  const existing = (settingsRaw.tts ?? {}) as Record<string, unknown>

  if (tts.enabled !== undefined) existing.enabled = !!tts.enabled
  if (tts.provider !== undefined) {
    const err = validateEnum(tts.provider, ['openai', 'mistral'], 'tts.provider')
    if (err) return { error: err }
    existing.provider = tts.provider
  }
  if (tts.providerId !== undefined) {
    if (typeof tts.providerId !== 'string') {
      return { error: 'tts.providerId must be a string' }
    }
    existing.providerId = tts.providerId
  }
  if (tts.openaiModel !== undefined) {
    const err = validateEnum(tts.openaiModel, ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'], 'tts.openaiModel')
    if (err) return { error: err }
    existing.openaiModel = tts.openaiModel
  }
  if (tts.openaiVoice !== undefined) {
    if (typeof tts.openaiVoice !== 'string' || !tts.openaiVoice) {
      return { error: 'tts.openaiVoice must be a non-empty string' }
    }
    existing.openaiVoice = tts.openaiVoice
  }
  if (tts.openaiInstructions !== undefined) {
    if (typeof tts.openaiInstructions !== 'string') {
      return { error: 'tts.openaiInstructions must be a string' }
    }
    existing.openaiInstructions = tts.openaiInstructions
  }
  if (tts.mistralVoice !== undefined) {
    if (typeof tts.mistralVoice !== 'string' || !tts.mistralVoice) {
      return { error: 'tts.mistralVoice must be a non-empty string' }
    }
    existing.mistralVoice = tts.mistralVoice
  }
  if (tts.responseFormat !== undefined) {
    const err = validateEnum(tts.responseFormat, ['mp3', 'wav', 'opus', 'flac'], 'tts.responseFormat')
    if (err) return { error: err }
    existing.responseFormat = tts.responseFormat
  }

  settingsRaw.tts = existing
  return { error: null }
}

function mergeTasks(
  body: Record<string, unknown>,
  settingsRaw: Record<string, unknown>,
): { error: string | null } {
  const tasks = body.tasks as Record<string, unknown> | undefined
  if (!tasks) return { error: null }

  const existing = (settingsRaw.tasks ?? {}) as Record<string, unknown>

  if (tasks.defaultProvider !== undefined) {
    if (typeof tasks.defaultProvider !== 'string') {
      return { error: 'tasks.defaultProvider must be a string' }
    }
    existing.defaultProvider = tasks.defaultProvider
  }
  if (tasks.maxDurationMinutes !== undefined) {
    const err = validatePositiveNumber(tasks.maxDurationMinutes, 'tasks.maxDurationMinutes')
    if (err) return { error: err }
    existing.maxDurationMinutes = tasks.maxDurationMinutes
  }
  if (tasks.telegramDelivery !== undefined) {
    const err = validateEnum(tasks.telegramDelivery, ['auto', 'always'], 'tasks.telegramDelivery')
    if (err) return { error: err }
    existing.telegramDelivery = tasks.telegramDelivery
  }

  if (tasks.loopDetection !== undefined) {
    const ld = tasks.loopDetection as Record<string, unknown>
    const existingLd = (existing.loopDetection ?? {}) as Record<string, unknown>

    if (ld.enabled !== undefined) existingLd.enabled = !!ld.enabled
    if (ld.method !== undefined) {
      const err = validateEnum(ld.method, ['systematic', 'smart', 'auto'], 'tasks.loopDetection.method')
      if (err) return { error: err }
      existingLd.method = ld.method
    }
    if (ld.maxConsecutiveFailures !== undefined) {
      const err = validatePositiveNumber(ld.maxConsecutiveFailures, 'tasks.loopDetection.maxConsecutiveFailures')
      if (err) return { error: err }
      existingLd.maxConsecutiveFailures = ld.maxConsecutiveFailures
    }
    if (ld.smartProvider !== undefined) {
      if (typeof ld.smartProvider !== 'string') {
        return { error: 'tasks.loopDetection.smartProvider must be a string' }
      }
      existingLd.smartProvider = ld.smartProvider
    }
    if (ld.smartCheckInterval !== undefined) {
      const err = validatePositiveNumber(ld.smartCheckInterval, 'tasks.loopDetection.smartCheckInterval')
      if (err) return { error: err }
      existingLd.smartCheckInterval = ld.smartCheckInterval
    }

    existing.loopDetection = existingLd
  }

  if (tasks.statusUpdateIntervalMinutes !== undefined) {
    const err = validatePositiveNumber(tasks.statusUpdateIntervalMinutes, 'tasks.statusUpdateIntervalMinutes')
    if (err) return { error: err }
    existing.statusUpdateIntervalMinutes = tasks.statusUpdateIntervalMinutes
  }

  settingsRaw.tasks = existing
  return { error: null }
}

// ── Default notification toggles ──────────────────────────────────────

const DEFAULT_NOTIFICATIONS: HealthMonitorNotificationToggles = {
  healthyToDegraded: false,
  degradedToHealthy: false,
  degradedToDown: true,
  healthyToDown: true,
  downToFallback: true,
  fallbackToHealthy: true,
}

// ── Response builders ─────────────────────────────────────────────────

function buildHealthMonitorResponse(settingsRaw: Record<string, unknown>) {
  const hm = (settingsRaw.healthMonitor ?? {}) as Record<string, unknown>
  return {
    fallbackTrigger: hm.fallbackTrigger ?? 'down',
    failuresBeforeFallback: hm.failuresBeforeFallback ?? 1,
    recoveryCheckIntervalMinutes: hm.recoveryCheckIntervalMinutes ?? 1,
    successesBeforeRecovery: hm.successesBeforeRecovery ?? 3,
    notifications: { ...DEFAULT_NOTIFICATIONS, ...(hm.notifications ?? {}) as Record<string, unknown> },
  }
}

function buildConsolidationResponse(settingsRaw: Record<string, unknown>) {
  const mc = (settingsRaw.memoryConsolidation ?? {}) as Record<string, unknown>
  return {
    enabled: mc.enabled ?? false,
    runAtHour: mc.runAtHour ?? 3,
    lookbackDays: mc.lookbackDays ?? 3,
    providerId: mc.providerId ?? '',
  }
}

function buildAgentHeartbeatResponse(settingsRaw: Record<string, unknown>) {
  const ah = (settingsRaw.agentHeartbeat ?? {}) as Record<string, unknown>
  const nm = (ah.nightMode ?? {}) as Record<string, unknown>
  return {
    enabled: ah.enabled ?? false,
    intervalMinutes: ah.intervalMinutes ?? 60,
    nightMode: {
      enabled: nm.enabled ?? true,
      startHour: nm.startHour ?? 23,
      endHour: nm.endHour ?? 8,
    },
  }
}

function buildTtsResponse(settingsRaw: Record<string, unknown>) {
  const tts = (settingsRaw.tts ?? {}) as Record<string, unknown>
  return {
    enabled: tts.enabled ?? false,
    provider: tts.provider ?? 'openai',
    providerId: tts.providerId ?? '',
    openaiModel: tts.openaiModel ?? 'gpt-4o-mini-tts',
    openaiVoice: tts.openaiVoice ?? 'nova',
    openaiInstructions: tts.openaiInstructions ?? '',
    mistralVoice: tts.mistralVoice ?? '',
    responseFormat: tts.responseFormat ?? 'mp3',
  }
}

function buildTasksResponse(settingsRaw: Record<string, unknown>) {
  const tasks = (settingsRaw.tasks ?? {}) as Record<string, unknown>
  const ld = (tasks.loopDetection ?? {}) as Record<string, unknown>
  return {
    defaultProvider: tasks.defaultProvider ?? '',
    maxDurationMinutes: tasks.maxDurationMinutes ?? 60,
    telegramDelivery: tasks.telegramDelivery ?? 'auto',
    loopDetection: {
      enabled: ld.enabled ?? true,
      method: ld.method ?? 'systematic',
      maxConsecutiveFailures: ld.maxConsecutiveFailures ?? 3,
      smartProvider: ld.smartProvider ?? '',
      smartCheckInterval: ld.smartCheckInterval ?? 5,
    },
    statusUpdateIntervalMinutes: tasks.statusUpdateIntervalMinutes ?? 10,
  }
}

// ── Router ────────────────────────────────────────────────────────────

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
      const settingsRaw = settings as unknown as Record<string, unknown>

      res.json({
        sessionTimeoutMinutes: settings.sessionTimeoutMinutes ?? 15,
        language: settings.language ?? 'match',
        timezone: settings.timezone ?? 'UTC',
        healthMonitorIntervalMinutes: settings.healthMonitorIntervalMinutes ?? settings.healthMonitor?.intervalMinutes ?? 5,
        uploadRetentionDays: settings.uploadRetentionDays ?? 30,
        batchingDelayMs: settings.batchingDelayMs ?? telegram.batchingDelayMs ?? 2500,
        telegramEnabled: telegram.enabled ?? false,
        telegramBotToken: telegram.botToken ?? '',
        healthMonitor: buildHealthMonitorResponse(settingsRaw),
        memoryConsolidation: buildConsolidationResponse(settingsRaw),
        agentHeartbeat: buildAgentHeartbeatResponse(settingsRaw),
        tasks: buildTasksResponse(settingsRaw),
        tts: buildTtsResponse(settingsRaw),
      })
    } catch (err) {
      res.status(500).json({ error: `Failed to read settings: ${(err as Error).message}` })
    }
  })

  router.put('/', (req: AuthenticatedRequest, res) => {
    const body = req.body as Record<string, unknown>

    try {
      ensureConfigTemplates()
      const configDir = getConfigDir()
      const settingsPath = path.join(configDir, 'settings.json')
      const telegramPath = path.join(configDir, 'telegram.json')

      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as SettingsData
      const telegram = JSON.parse(fs.readFileSync(telegramPath, 'utf-8')) as TelegramData
      const previousHealthMonitorInterval = settings.healthMonitorIntervalMinutes ?? 5
      const previousBatchingDelayMs = settings.batchingDelayMs ?? telegram.batchingDelayMs ?? 2500
      const previousTelegramEnabled = telegram.enabled
      const previousTelegramBotToken = telegram.botToken

      // ── Scalar settings ──
      if (body.sessionTimeoutMinutes !== undefined) {
        const err = validatePositiveNumber(body.sessionTimeoutMinutes, 'sessionTimeoutMinutes')
        if (err) { res.status(400).json({ error: err }); return }
        settings.sessionTimeoutMinutes = body.sessionTimeoutMinutes as number
      }
      if (body.language !== undefined) {
        const err = validateNonEmptyString(body.language, 'language')
        if (err) { res.status(400).json({ error: err }); return }
        settings.language = (body.language as string).trim()
      }
      if (body.timezone !== undefined) {
        const err = validateNonEmptyString(body.timezone, 'timezone')
        if (err) { res.status(400).json({ error: err }); return }
        settings.timezone = (body.timezone as string).trim()
      }
      if (body.healthMonitorIntervalMinutes !== undefined) {
        const err = validatePositiveNumber(body.healthMonitorIntervalMinutes, 'healthMonitorIntervalMinutes')
        if (err) { res.status(400).json({ error: err }); return }
        settings.healthMonitorIntervalMinutes = body.healthMonitorIntervalMinutes as number
      }
      if (body.uploadRetentionDays !== undefined) {
        const err = validateNonNegativeNumber(body.uploadRetentionDays, 'uploadRetentionDays')
        if (err) { res.status(400).json({ error: err }); return }
        settings.uploadRetentionDays = body.uploadRetentionDays as number
      }
      if (body.batchingDelayMs !== undefined) {
        const err = validateNonNegativeNumber(body.batchingDelayMs, 'batchingDelayMs')
        if (err) { res.status(400).json({ error: err }); return }
        settings.batchingDelayMs = body.batchingDelayMs as number
      }

      // ── Nested settings groups ──
      const settingsRaw = settings as unknown as Record<string, unknown>

      const hm = mergeHealthMonitor(body, settingsRaw)
      if (hm.error) { res.status(400).json({ error: hm.error }); return }

      const mc = mergeConsolidation(body, settingsRaw)
      if (mc.error) { res.status(400).json({ error: mc.error }); return }

      const ah = mergeAgentHeartbeat(body, settingsRaw)
      if (ah.error) { res.status(400).json({ error: ah.error }); return }

      const tk = mergeTasks(body, settingsRaw)
      if (tk.error) { res.status(400).json({ error: tk.error }); return }

      const ttsResult = mergeTts(body, settingsRaw)
      if (ttsResult.error) { res.status(400).json({ error: ttsResult.error }); return }

      // ── Telegram ──
      if (body.telegramEnabled !== undefined) {
        telegram.enabled = !!body.telegramEnabled
      }
      if (body.telegramBotToken !== undefined) {
        if (typeof body.telegramBotToken !== 'string') {
          res.status(400).json({ error: 'telegramBotToken must be a string' })
          return
        }
        telegram.botToken = (body.telegramBotToken as string).trim()
      }

      // ── Persist ──
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8')
      fs.writeFileSync(telegramPath, JSON.stringify(telegram, null, 2) + '\n', 'utf-8')

      // ── Live updates ──
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

      // ── Notify dependent services ──
      if ((settings.healthMonitorIntervalMinutes ?? 5) !== previousHealthMonitorInterval || hm.changed) {
        options.onHealthMonitorSettingsChanged?.()
      }
      if (mc.changed) {
        options.onConsolidationSettingsChanged?.()
      }
      if (ah.changed) {
        options.onAgentHeartbeatSettingsChanged?.()
      }
      if (telegram.enabled !== previousTelegramEnabled || telegram.botToken !== previousTelegramBotToken) {
        options.onTelegramSettingsChanged?.()
      }

      // ── Response ──
      res.json({
        message: 'Settings updated',
        sessionTimeoutMinutes: settings.sessionTimeoutMinutes,
        language: settings.language,
        timezone: settings.timezone ?? 'UTC',
        healthMonitorIntervalMinutes: settings.healthMonitorIntervalMinutes,
        batchingDelayMs: settings.batchingDelayMs ?? previousBatchingDelayMs,
        uploadRetentionDays: settings.uploadRetentionDays ?? 30,
        telegramEnabled: telegram.enabled,
        telegramBotToken: telegram.botToken,
        healthMonitor: buildHealthMonitorResponse(settingsRaw),
        memoryConsolidation: buildConsolidationResponse(settingsRaw),
        agentHeartbeat: buildAgentHeartbeatResponse(settingsRaw),
        tasks: buildTasksResponse(settingsRaw),
        tts: buildTtsResponse(settingsRaw),
      })
    } catch (err) {
      res.status(500).json({ error: `Failed to update settings: ${(err as Error).message}` })
    }
  })

  return router
}
