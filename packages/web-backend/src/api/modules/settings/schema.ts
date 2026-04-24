import {
  HEALTH_MONITOR_FALLBACK_TRIGGERS,
  SETTINGS_STT_OPENAI_MODELS,
  SETTINGS_STT_PROVIDERS,
  SETTINGS_THINKING_LEVELS,
  SETTINGS_TTS_OPENAI_MODELS,
  SETTINGS_TTS_PROVIDERS,
  SETTINGS_TTS_RESPONSE_FORMATS,
  TASK_LOOP_DETECTION_METHODS,
  TASK_TELEGRAM_DELIVERY_VALUES,
  withLegacySettingsPayloadCompatibility,
} from '@axiom/core'

export interface MergeGroupResult {
  error: string | null
  changed: boolean
}

export function normalizeSettingsPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return withLegacySettingsPayloadCompatibility(payload)
}

export function validatePositiveNumber(value: unknown, name: string): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    return `${name} must be a positive number`
  }
  return null
}

export function validateIntegerRange(value: unknown, name: string, min: number, max: number): string | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    return `${name} must be an integer ${min}-${max}`
  }
  return null
}

export function validateNonNegativeNumber(value: unknown, name: string): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return `${name} must be a non-negative number`
  }
  return null
}

export function validateHour(value: unknown, name: string): string | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 23) {
    return `${name} must be an integer 0-23`
  }
  return null
}

export function validateNonEmptyString(value: unknown, name: string): string | null {
  if (typeof value !== 'string' || !value.trim()) {
    return `${name} must be a non-empty string`
  }
  return null
}

export function validateEnum(value: unknown, allowed: readonly string[], name: string): string | null {
  if (!allowed.includes(value as string)) {
    return `${name} must be ${allowed.map(a => `"${a}"`).join(' or ')}`
  }
  return null
}

export function mergeHealthMonitor(
  body: Record<string, unknown>,
  settingsRaw: Record<string, unknown>,
): MergeGroupResult {
  const incoming = body.healthMonitor as Record<string, unknown> | undefined
  if (!incoming) return { error: null, changed: false }

  const existing = (settingsRaw.healthMonitor ?? {}) as Record<string, unknown>
  let changed = false

  if (incoming.enabled !== undefined) {
    existing.enabled = !!incoming.enabled
    changed = true
  }

  if (incoming.fallbackTrigger !== undefined) {
    const err = validateEnum(incoming.fallbackTrigger, HEALTH_MONITOR_FALLBACK_TRIGGERS, 'healthMonitor.fallbackTrigger')
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

export function mergeConsolidation(
  body: Record<string, unknown>,
  settingsRaw: Record<string, unknown>,
): MergeGroupResult {
  const memoryConsolidation = body.memoryConsolidation as Record<string, unknown> | undefined
  if (!memoryConsolidation) return { error: null, changed: false }

  const existing = (settingsRaw.memoryConsolidation ?? {}) as Record<string, unknown>

  if (memoryConsolidation.enabled !== undefined) existing.enabled = !!memoryConsolidation.enabled

  if (memoryConsolidation.runAtHour !== undefined) {
    const err = validateHour(memoryConsolidation.runAtHour, 'memoryConsolidation.runAtHour')
    if (err) return { error: err, changed: false }
    existing.runAtHour = memoryConsolidation.runAtHour
  }

  if (memoryConsolidation.lookbackDays !== undefined) {
    if (
      typeof memoryConsolidation.lookbackDays !== 'number'
      || !Number.isInteger(memoryConsolidation.lookbackDays)
      || memoryConsolidation.lookbackDays < 1
      || memoryConsolidation.lookbackDays > 30
    ) {
      return { error: 'memoryConsolidation.lookbackDays must be an integer 1-30', changed: false }
    }
    existing.lookbackDays = memoryConsolidation.lookbackDays
  }

  if (memoryConsolidation.providerId !== undefined) {
    if (typeof memoryConsolidation.providerId !== 'string') {
      return { error: 'memoryConsolidation.providerId must be a string', changed: false }
    }
    existing.providerId = memoryConsolidation.providerId
  }

  settingsRaw.memoryConsolidation = existing
  return { error: null, changed: true }
}

export function mergeFactExtraction(
  body: Record<string, unknown>,
  settingsRaw: Record<string, unknown>,
): MergeGroupResult {
  const factExtraction = body.factExtraction as Record<string, unknown> | undefined
  if (!factExtraction) return { error: null, changed: false }

  const existing = (settingsRaw.factExtraction ?? {}) as Record<string, unknown>

  if (factExtraction.enabled !== undefined) existing.enabled = !!factExtraction.enabled

  if (factExtraction.providerId !== undefined) {
    if (typeof factExtraction.providerId !== 'string') {
      return { error: 'factExtraction.providerId must be a string', changed: false }
    }
    existing.providerId = factExtraction.providerId
  }

  if (factExtraction.minSessionMessages !== undefined) {
    if (
      typeof factExtraction.minSessionMessages !== 'number'
      || !Number.isInteger(factExtraction.minSessionMessages)
      || factExtraction.minSessionMessages < 1
      || factExtraction.minSessionMessages > 100
    ) {
      return { error: 'factExtraction.minSessionMessages must be an integer 1-100', changed: false }
    }
    existing.minSessionMessages = factExtraction.minSessionMessages
  }

  settingsRaw.factExtraction = existing
  return { error: null, changed: true }
}

export function mergeAgentHeartbeat(
  body: Record<string, unknown>,
  settingsRaw: Record<string, unknown>,
): MergeGroupResult {
  const agentHeartbeat = body.agentHeartbeat as Record<string, unknown> | undefined
  if (!agentHeartbeat) return { error: null, changed: false }

  const existing = (settingsRaw.agentHeartbeat ?? {}) as Record<string, unknown>

  if (agentHeartbeat.enabled !== undefined) existing.enabled = !!agentHeartbeat.enabled

  if (agentHeartbeat.intervalMinutes !== undefined) {
    const err = validatePositiveNumber(agentHeartbeat.intervalMinutes, 'agentHeartbeat.intervalMinutes')
    if (err) return { error: err, changed: false }
    existing.intervalMinutes = agentHeartbeat.intervalMinutes
  }

  if (agentHeartbeat.nightMode !== undefined) {
    const nightMode = agentHeartbeat.nightMode as Record<string, unknown>
    const existingNightMode = (existing.nightMode ?? {}) as Record<string, unknown>

    if (nightMode.enabled !== undefined) existingNightMode.enabled = !!nightMode.enabled

    if (nightMode.startHour !== undefined) {
      const err = validateHour(nightMode.startHour, 'agentHeartbeat.nightMode.startHour')
      if (err) return { error: err, changed: false }
      existingNightMode.startHour = nightMode.startHour
    }

    if (nightMode.endHour !== undefined) {
      const err = validateHour(nightMode.endHour, 'agentHeartbeat.nightMode.endHour')
      if (err) return { error: err, changed: false }
      existingNightMode.endHour = nightMode.endHour
    }

    existing.nightMode = existingNightMode
  }

  settingsRaw.agentHeartbeat = existing
  return { error: null, changed: true }
}

export function mergeTasks(
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
    const err = validateEnum(tasks.telegramDelivery, TASK_TELEGRAM_DELIVERY_VALUES, 'tasks.telegramDelivery')
    if (err) return { error: err }
    existing.telegramDelivery = tasks.telegramDelivery
  }

  if (tasks.loopDetection !== undefined) {
    const loopDetection = tasks.loopDetection as Record<string, unknown>
    const existingLoopDetection = (existing.loopDetection ?? {}) as Record<string, unknown>

    if (loopDetection.enabled !== undefined) existingLoopDetection.enabled = !!loopDetection.enabled

    if (loopDetection.method !== undefined) {
      const err = validateEnum(loopDetection.method, TASK_LOOP_DETECTION_METHODS, 'tasks.loopDetection.method')
      if (err) return { error: err }
      existingLoopDetection.method = loopDetection.method
    }

    if (loopDetection.maxConsecutiveFailures !== undefined) {
      const err = validatePositiveNumber(loopDetection.maxConsecutiveFailures, 'tasks.loopDetection.maxConsecutiveFailures')
      if (err) return { error: err }
      existingLoopDetection.maxConsecutiveFailures = loopDetection.maxConsecutiveFailures
    }

    if (loopDetection.smartProvider !== undefined) {
      if (typeof loopDetection.smartProvider !== 'string') {
        return { error: 'tasks.loopDetection.smartProvider must be a string' }
      }
      existingLoopDetection.smartProvider = loopDetection.smartProvider
    }

    if (loopDetection.smartCheckInterval !== undefined) {
      const err = validatePositiveNumber(loopDetection.smartCheckInterval, 'tasks.loopDetection.smartCheckInterval')
      if (err) return { error: err }
      existingLoopDetection.smartCheckInterval = loopDetection.smartCheckInterval
    }

    existing.loopDetection = existingLoopDetection
  }

  if (tasks.statusUpdates !== undefined) {
    const statusUpdates = tasks.statusUpdates as Record<string, unknown>
    const existingStatusUpdates = (existing.statusUpdates ?? {}) as Record<string, unknown>

    if (statusUpdates.enabled !== undefined) {
      existingStatusUpdates.enabled = !!statusUpdates.enabled
    }

    if (statusUpdates.intervalMinutes !== undefined) {
      const err = validateIntegerRange(statusUpdates.intervalMinutes, 'tasks.statusUpdates.intervalMinutes', 1, 120)
      if (err) return { error: err }
      existingStatusUpdates.intervalMinutes = statusUpdates.intervalMinutes
    }

    existing.statusUpdates = existingStatusUpdates
  }

  // Legacy flat key — preserved so existing PATCH callers that still send
  // `tasks.statusUpdateIntervalMinutes` keep working. We migrate it into the
  // new sub-object without clobbering an explicit `enabled` flag.
  if (tasks.statusUpdateIntervalMinutes !== undefined) {
    const err = validateIntegerRange(tasks.statusUpdateIntervalMinutes, 'tasks.statusUpdateIntervalMinutes', 1, 120)
    if (err) return { error: err }
    const existingStatusUpdates = (existing.statusUpdates ?? {}) as Record<string, unknown>
    existingStatusUpdates.intervalMinutes = tasks.statusUpdateIntervalMinutes
    existing.statusUpdates = existingStatusUpdates
  }

  if (tasks.backgroundThinkingLevel !== undefined) {
    const err = validateEnum(tasks.backgroundThinkingLevel, SETTINGS_THINKING_LEVELS, 'tasks.backgroundThinkingLevel')
    if (err) return { error: err }
    existing.backgroundThinkingLevel = tasks.backgroundThinkingLevel
  }

  settingsRaw.tasks = existing
  return { error: null }
}

export function mergeTts(
  body: Record<string, unknown>,
  settingsRaw: Record<string, unknown>,
): { error: string | null } {
  const tts = body.tts as Record<string, unknown> | undefined
  if (!tts) return { error: null }

  const existing = (settingsRaw.tts ?? {}) as Record<string, unknown>

  if (tts.enabled !== undefined) existing.enabled = !!tts.enabled

  if (tts.provider !== undefined) {
    const err = validateEnum(tts.provider, SETTINGS_TTS_PROVIDERS, 'tts.provider')
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
    const err = validateEnum(tts.openaiModel, SETTINGS_TTS_OPENAI_MODELS, 'tts.openaiModel')
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
    if (typeof tts.mistralVoice !== 'string') {
      return { error: 'tts.mistralVoice must be a string' }
    }
    existing.mistralVoice = tts.mistralVoice
  }

  if (tts.responseFormat !== undefined) {
    const err = validateEnum(tts.responseFormat, SETTINGS_TTS_RESPONSE_FORMATS, 'tts.responseFormat')
    if (err) return { error: err }
    existing.responseFormat = tts.responseFormat
  }

  settingsRaw.tts = existing
  return { error: null }
}

export function mergeUploads(
  body: Record<string, unknown>,
  settingsRaw: Record<string, unknown>,
): MergeGroupResult {
  const uploads = body.uploads as Record<string, unknown> | undefined
  if (!uploads) return { error: null, changed: false }

  const existing = (settingsRaw.uploads ?? {}) as Record<string, unknown>

  if (uploads.retentionDays !== undefined) {
    const err = validateNonNegativeNumber(uploads.retentionDays, 'uploads.retentionDays')
    if (err) return { error: err, changed: false }
    existing.retentionDays = uploads.retentionDays
  }

  settingsRaw.uploads = existing
  return { error: null, changed: true }
}

export function mergeStt(
  body: Record<string, unknown>,
  settingsRaw: Record<string, unknown>,
): { error: string | null } {
  const stt = body.stt as Record<string, unknown> | undefined
  if (!stt) return { error: null }

  const existing = (settingsRaw.stt ?? {}) as Record<string, unknown>

  if (stt.enabled !== undefined) existing.enabled = !!stt.enabled

  if (stt.provider !== undefined) {
    const err = validateEnum(stt.provider, SETTINGS_STT_PROVIDERS, 'stt.provider')
    if (err) return { error: err }
    existing.provider = stt.provider
  }

  if (stt.whisperUrl !== undefined) {
    if (typeof stt.whisperUrl !== 'string') {
      return { error: 'stt.whisperUrl must be a string' }
    }
    existing.whisperUrl = stt.whisperUrl
  }

  if (stt.providerId !== undefined) {
    if (typeof stt.providerId !== 'string') {
      return { error: 'stt.providerId must be a string' }
    }
    existing.providerId = stt.providerId
  }

  if (stt.openaiModel !== undefined) {
    const err = validateEnum(stt.openaiModel, SETTINGS_STT_OPENAI_MODELS, 'stt.openaiModel')
    if (err) return { error: err }
    existing.openaiModel = stt.openaiModel
  }

  if (stt.ollamaModel !== undefined) {
    if (typeof stt.ollamaModel !== 'string') {
      return { error: 'stt.ollamaModel must be a string' }
    }
    existing.ollamaModel = stt.ollamaModel
  }

  if (stt.rewrite !== undefined) {
    const rewrite = stt.rewrite as Record<string, unknown>
    const existingRewrite = (existing.rewrite ?? {}) as Record<string, unknown>

    if (rewrite.enabled !== undefined) existingRewrite.enabled = !!rewrite.enabled

    if (rewrite.providerId !== undefined) {
      if (typeof rewrite.providerId !== 'string') {
        return { error: 'stt.rewrite.providerId must be a string' }
      }
      existingRewrite.providerId = rewrite.providerId
    }

    existing.rewrite = existingRewrite
  }

  settingsRaw.stt = existing
  return { error: null }
}
