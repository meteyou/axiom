import { DEFAULT_HEALTH_MONITOR_NOTIFICATION_TOGGLES } from '@axiom/core'
import type { HealthMonitorNotificationToggles, SettingsData, TelegramData } from './types.js'

const DEFAULT_NOTIFICATIONS: HealthMonitorNotificationToggles = {
  ...DEFAULT_HEALTH_MONITOR_NOTIFICATION_TOGGLES,
}

export interface SettingsResponseContext {
  settings: SettingsData
  telegram: TelegramData
  batchingDelayMs: number
}

function buildHealthMonitorResponse(settingsRaw: Record<string, unknown>) {
  const healthMonitor = (settingsRaw.healthMonitor ?? {}) as Record<string, unknown>
  return {
    enabled: healthMonitor.enabled ?? true,
    fallbackTrigger: healthMonitor.fallbackTrigger ?? 'down',
    failuresBeforeFallback: healthMonitor.failuresBeforeFallback ?? 1,
    recoveryCheckIntervalMinutes: healthMonitor.recoveryCheckIntervalMinutes ?? 1,
    successesBeforeRecovery: healthMonitor.successesBeforeRecovery ?? 3,
    notifications: {
      ...DEFAULT_NOTIFICATIONS,
      ...(healthMonitor.notifications ?? {}) as Record<string, unknown>,
    },
  }
}

function buildConsolidationResponse(settingsRaw: Record<string, unknown>) {
  const memoryConsolidation = (settingsRaw.memoryConsolidation ?? {}) as Record<string, unknown>
  return {
    enabled: memoryConsolidation.enabled ?? true,
    runAtHour: memoryConsolidation.runAtHour ?? 3,
    lookbackDays: memoryConsolidation.lookbackDays ?? 3,
    providerId: memoryConsolidation.providerId ?? '',
  }
}

function buildFactExtractionResponse(settingsRaw: Record<string, unknown>) {
  const factExtraction = (settingsRaw.factExtraction ?? {}) as Record<string, unknown>
  return {
    enabled: factExtraction.enabled ?? true,
    providerId: factExtraction.providerId ?? '',
    minSessionMessages: factExtraction.minSessionMessages ?? 3,
  }
}

function buildAgentHeartbeatResponse(settingsRaw: Record<string, unknown>) {
  const agentHeartbeat = (settingsRaw.agentHeartbeat ?? {}) as Record<string, unknown>
  const nightMode = (agentHeartbeat.nightMode ?? {}) as Record<string, unknown>

  return {
    enabled: agentHeartbeat.enabled ?? false,
    intervalMinutes: agentHeartbeat.intervalMinutes ?? 60,
    nightMode: {
      enabled: nightMode.enabled ?? true,
      startHour: nightMode.startHour ?? 23,
      endHour: nightMode.endHour ?? 8,
    },
  }
}

function buildTasksResponse(settingsRaw: Record<string, unknown>) {
  const tasks = (settingsRaw.tasks ?? {}) as Record<string, unknown>
  const loopDetection = (tasks.loopDetection ?? {}) as Record<string, unknown>

  return {
    defaultProvider: tasks.defaultProvider ?? '',
    maxDurationMinutes: tasks.maxDurationMinutes ?? 60,
    telegramDelivery: tasks.telegramDelivery ?? 'auto',
    loopDetection: {
      enabled: loopDetection.enabled ?? true,
      method: loopDetection.method ?? 'systematic',
      maxConsecutiveFailures: loopDetection.maxConsecutiveFailures ?? 3,
      smartProvider: loopDetection.smartProvider ?? '',
      smartCheckInterval: loopDetection.smartCheckInterval ?? 5,
    },
    statusUpdateIntervalMinutes: tasks.statusUpdateIntervalMinutes ?? 10,
    backgroundThinkingLevel: tasks.backgroundThinkingLevel ?? 'off',
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

function buildUploadsResponse(settingsRaw: Record<string, unknown>) {
  const uploads = (settingsRaw.uploads ?? {}) as Record<string, unknown>
  const retentionDays = typeof uploads.retentionDays === 'number' ? uploads.retentionDays : 30
  return { retentionDays }
}

function buildSttResponse(settingsRaw: Record<string, unknown>) {
  const stt = (settingsRaw.stt ?? {}) as Record<string, unknown>
  const rewrite = (stt.rewrite ?? {}) as Record<string, unknown>
  return {
    enabled: stt.enabled ?? false,
    provider: stt.provider ?? 'whisper-url',
    whisperUrl: stt.whisperUrl ?? '',
    providerId: stt.providerId ?? '',
    openaiModel: stt.openaiModel ?? 'whisper-1',
    ollamaModel: stt.ollamaModel ?? '',
    rewrite: {
      enabled: rewrite.enabled ?? false,
      providerId: rewrite.providerId ?? '',
    },
  }
}

export function mapSettingsResponse(context: SettingsResponseContext) {
  const settingsRaw = context.settings as unknown as Record<string, unknown>

  return {
    sessionTimeoutMinutes: context.settings.sessionTimeoutMinutes ?? 30,
    sessionSummaryProviderId: (settingsRaw.sessionSummaryProviderId as string) ?? '',
    language: context.settings.language ?? 'match',
    timezone: context.settings.timezone ?? 'UTC',
    thinkingLevel: (settingsRaw.thinkingLevel as string) ?? 'off',
    healthMonitorIntervalMinutes:
      context.settings.healthMonitorIntervalMinutes
      ?? (context.settings.healthMonitor as Record<string, unknown> | undefined)?.intervalMinutes
      ?? 5,
    uploads: buildUploadsResponse(settingsRaw),
    batchingDelayMs: context.batchingDelayMs,
    telegramEnabled: context.telegram.enabled ?? false,
    telegramBotToken: context.telegram.botToken ?? '',
    healthMonitor: buildHealthMonitorResponse(settingsRaw),
    memoryConsolidation: buildConsolidationResponse(settingsRaw),
    factExtraction: buildFactExtractionResponse(settingsRaw),
    agentHeartbeat: buildAgentHeartbeatResponse(settingsRaw),
    tasks: buildTasksResponse(settingsRaw),
    tts: buildTtsResponse(settingsRaw),
    stt: buildSttResponse(settingsRaw),
  }
}

export function mapSettingsUpdateResponse(context: SettingsResponseContext) {
  return {
    message: 'Settings updated',
    ...mapSettingsResponse(context),
    healthMonitorIntervalMinutes: context.settings.healthMonitorIntervalMinutes,
  }
}
