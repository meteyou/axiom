import fs from 'node:fs'
import path from 'node:path'
import { ensureConfigTemplates, getConfigDir, loadConfig, SETTINGS_THINKING_LEVELS } from '@axiom/core'
import type { SettingsData, SettingsRouterOptions, TelegramData } from './types.js'
import {
  mergeAgentHeartbeat,
  mergeConsolidation,
  mergeFactExtraction,
  mergeHealthMonitor,
  mergeStt,
  mergeTasks,
  mergeTts,
  normalizeSettingsPayload,
  validateEnum,
  validateNonEmptyString,
  validateNonNegativeNumber,
  validatePositiveNumber,
} from './schema.js'
import { mapSettingsResponse, mapSettingsUpdateResponse } from './mapper.js'

export class SettingsValidationError extends Error {}

export interface SettingsService {
  readSettings: () => ReturnType<typeof mapSettingsResponse>
  updateSettings: (payload: Record<string, unknown>) => ReturnType<typeof mapSettingsUpdateResponse>
}

export function createSettingsService(options: SettingsRouterOptions = {}): SettingsService {
  const getAgentCore = options.getAgentCore ?? (() => null)

  function readConfigFiles(): { settings: SettingsData; telegram: TelegramData } {
    ensureConfigTemplates()

    return {
      settings: loadConfig<SettingsData>('settings.json'),
      telegram: loadConfig<TelegramData>('telegram.json'),
    }
  }

  function readSettings() {
    const { settings, telegram } = readConfigFiles()

    return mapSettingsResponse({
      settings,
      telegram,
      batchingDelayMs: settings.batchingDelayMs ?? telegram.batchingDelayMs ?? 2500,
    })
  }

  function updateSettings(payload: Record<string, unknown>) {
    const body = normalizeSettingsPayload(payload)

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

    if (body.sessionTimeoutMinutes !== undefined) {
      const err = validatePositiveNumber(body.sessionTimeoutMinutes, 'sessionTimeoutMinutes')
      if (err) throw new SettingsValidationError(err)
      settings.sessionTimeoutMinutes = body.sessionTimeoutMinutes as number
    }

    if (body.sessionSummaryProviderId !== undefined) {
      if (typeof body.sessionSummaryProviderId !== 'string') {
        throw new SettingsValidationError('sessionSummaryProviderId must be a string')
      }
      (settings as unknown as Record<string, unknown>).sessionSummaryProviderId = body.sessionSummaryProviderId
    }

    if (body.language !== undefined) {
      const err = validateNonEmptyString(body.language, 'language')
      if (err) throw new SettingsValidationError(err)
      settings.language = (body.language as string).trim()
    }

    if (body.timezone !== undefined) {
      const err = validateNonEmptyString(body.timezone, 'timezone')
      if (err) throw new SettingsValidationError(err)
      settings.timezone = (body.timezone as string).trim()
    }

    if (body.thinkingLevel !== undefined) {
      const err = validateEnum(body.thinkingLevel, SETTINGS_THINKING_LEVELS, 'thinkingLevel')
      if (err) throw new SettingsValidationError(err)
      ;(settings as unknown as Record<string, unknown>).thinkingLevel = body.thinkingLevel
    }

    if (body.healthMonitorIntervalMinutes !== undefined) {
      const err = validatePositiveNumber(body.healthMonitorIntervalMinutes, 'healthMonitorIntervalMinutes')
      if (err) throw new SettingsValidationError(err)
      settings.healthMonitorIntervalMinutes = body.healthMonitorIntervalMinutes as number
    }

    if (body.uploadRetentionDays !== undefined) {
      const err = validateNonNegativeNumber(body.uploadRetentionDays, 'uploadRetentionDays')
      if (err) throw new SettingsValidationError(err)
      settings.uploadRetentionDays = body.uploadRetentionDays as number
    }

    if (body.batchingDelayMs !== undefined) {
      const err = validateNonNegativeNumber(body.batchingDelayMs, 'batchingDelayMs')
      if (err) throw new SettingsValidationError(err)
      settings.batchingDelayMs = body.batchingDelayMs as number
    }

    const settingsRaw = settings as unknown as Record<string, unknown>

    const healthMonitorMerge = mergeHealthMonitor(body, settingsRaw)
    if (healthMonitorMerge.error) throw new SettingsValidationError(healthMonitorMerge.error)

    const consolidationMerge = mergeConsolidation(body, settingsRaw)
    if (consolidationMerge.error) throw new SettingsValidationError(consolidationMerge.error)

    const factExtractionMerge = mergeFactExtraction(body, settingsRaw)
    if (factExtractionMerge.error) throw new SettingsValidationError(factExtractionMerge.error)

    const agentHeartbeatMerge = mergeAgentHeartbeat(body, settingsRaw)
    if (agentHeartbeatMerge.error) throw new SettingsValidationError(agentHeartbeatMerge.error)

    const tasksMerge = mergeTasks(body, settingsRaw)
    if (tasksMerge.error) throw new SettingsValidationError(tasksMerge.error)

    const ttsMerge = mergeTts(body, settingsRaw)
    if (ttsMerge.error) throw new SettingsValidationError(ttsMerge.error)

    const sttMerge = mergeStt(body, settingsRaw)
    if (sttMerge.error) throw new SettingsValidationError(sttMerge.error)

    if (body.telegramEnabled !== undefined) {
      telegram.enabled = !!body.telegramEnabled
    }

    if (body.telegramBotToken !== undefined) {
      if (typeof body.telegramBotToken !== 'string') {
        throw new SettingsValidationError('telegramBotToken must be a string')
      }
      telegram.botToken = body.telegramBotToken.trim()
    }

    fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf-8')
    fs.writeFileSync(telegramPath, `${JSON.stringify(telegram, null, 2)}\n`, 'utf-8')

    const agentCore = getAgentCore()
    if (agentCore) {
      try {
        if (body.sessionTimeoutMinutes !== undefined) {
          agentCore.getSessionManager().setTimeoutMinutes(settings.sessionTimeoutMinutes)
        }
        if (body.language !== undefined || body.timezone !== undefined) {
          agentCore.refreshSystemPrompt()
        }
        if (body.thinkingLevel !== undefined) {
          agentCore.setThinkingLevel(body.thinkingLevel as string)
        }
      } catch (err) {
        console.error('[axiom] Failed to apply live settings update:', err)
      }
    }

    if ((settings.healthMonitorIntervalMinutes ?? 5) !== previousHealthMonitorInterval || healthMonitorMerge.changed) {
      options.onHealthMonitorSettingsChanged?.()
    }

    if (consolidationMerge.changed) {
      options.onConsolidationSettingsChanged?.()
    }

    if (agentHeartbeatMerge.changed) {
      options.onAgentHeartbeatSettingsChanged?.()
    }

    if (telegram.enabled !== previousTelegramEnabled || telegram.botToken !== previousTelegramBotToken) {
      options.onTelegramSettingsChanged?.()
    }

    return mapSettingsUpdateResponse({
      settings,
      telegram,
      batchingDelayMs: settings.batchingDelayMs ?? previousBatchingDelayMs,
    })
  }

  return {
    readSettings,
    updateSettings,
  }
}
