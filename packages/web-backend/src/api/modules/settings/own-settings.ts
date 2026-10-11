import {
  SETTINGS_THINKING_LEVELS,
  getGlobalChatDefaults,
  getUserSettingsOverrides,
  isValidTimezone,
  isSelectableChatModel,
  listSelectableChatModels,
  resolveUserScope,
  setActiveProvider,
  updateUserSettings,
} from '@axiom/core'
import type {
  ChatModelRef,
  Database,
  SelectableChatProvider,
  SettingsThinkingLevel,
  UserSettingsPatch,
} from '@axiom/core'
import { SettingsValidationError } from './service.js'
import type { SettingsService } from './service.js'

const MAX_LANGUAGE_LENGTH = 64

export interface OwnSettingsDefaults {
  chatModel: (ChatModelRef & { providerName: string | null }) | null
  thinkingLevel: SettingsThinkingLevel
  language: string
  timezone: string
}

export interface OwnSettingsResponse {
  scope: 'personal' | 'global'
  overrides: {
    chatModel: ChatModelRef | null
    thinkingLevel: SettingsThinkingLevel | null
    language: string | null
    timezone: string | null
  }
  defaults: OwnSettingsDefaults
  effective: {
    chatModel: ChatModelRef | null
    thinkingLevel: SettingsThinkingLevel
    language: string
    timezone: string
  }
}

export interface OwnSettingsService {
  read: (userId: number) => OwnSettingsResponse
  update: (userId: number, body: Record<string, unknown>) => OwnSettingsResponse
  listChatModels: () => SelectableChatProvider[]
}

function parseChatModel(value: unknown): ChatModelRef | null {
  if (value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new SettingsValidationError('chatModel must be an object or null')
  }
  const { providerId, modelId } = value as Record<string, unknown>
  if (typeof providerId !== 'string' || typeof modelId !== 'string' || !providerId || !modelId) {
    throw new SettingsValidationError('chatModel requires providerId and modelId')
  }
  const ref = { providerId, modelId }
  if (!isSelectableChatModel(ref)) {
    throw new SettingsValidationError(`Model "${modelId}" is not an enabled model of provider "${providerId}"`)
  }
  return ref
}

function parsePatch(body: Record<string, unknown>, global: boolean): UserSettingsPatch {
  const patch: UserSettingsPatch = {}
  if (body.chatModel !== undefined) {
    patch.chatModel = parseChatModel(body.chatModel)
  }
  if (body.thinkingLevel !== undefined) {
    if (body.thinkingLevel !== null && !(SETTINGS_THINKING_LEVELS as readonly unknown[]).includes(body.thinkingLevel)) {
      throw new SettingsValidationError(`thinkingLevel must be one of: ${SETTINGS_THINKING_LEVELS.join(', ')} or null`)
    }
    patch.thinkingLevel = body.thinkingLevel as SettingsThinkingLevel | null
  }
  if (body.language !== undefined) {
    if (body.language !== null && (typeof body.language !== 'string' || !body.language.trim() || body.language.length > MAX_LANGUAGE_LENGTH)) {
      throw new SettingsValidationError('language must be a non-empty string or null')
    }
    patch.language = body.language as string | null
  }
  if (body.timezone !== undefined) {
    if (body.timezone !== null && (typeof body.timezone !== 'string' || !isValidTimezone(body.timezone.trim()))) {
      throw new SettingsValidationError('timezone must be a valid IANA timezone (e.g. Europe/Berlin) or null')
    }
    patch.timezone = body.timezone === null ? null : (body.timezone as string).trim()
  }
  if (global && (patch.chatModel === null || patch.thinkingLevel === null || patch.language === null || patch.timezone === null)) {
    throw new SettingsValidationError('Admins change the global settings and cannot reset them to the default')
  }
  return patch
}

export function createOwnSettingsService(
  db: Database,
  globalSettings: SettingsService,
  onActiveProviderChanged?: () => void,
  onTimezoneChanged?: (userId: number | null) => void,
): OwnSettingsService {
  function read(userId: number): OwnSettingsResponse {
    const scope = resolveUserScope(db, userId)
    if (!scope) throw new SettingsValidationError('User not found')
    const defaults = getGlobalChatDefaults()
    const global = scope.role === 'admin'
    const overrides = global
      ? { chatModel: null, thinkingLevel: null, language: null, timezone: null }
      : getUserSettingsOverrides(db, userId)
    return {
      scope: global ? 'global' : 'personal',
      overrides,
      defaults: {
        chatModel: defaults.chatModel ? { ...defaults.chatModel, providerName: defaults.providerName } : null,
        thinkingLevel: defaults.thinkingLevel,
        language: defaults.language,
        timezone: defaults.timezone,
      },
      effective: {
        chatModel: scope.settings.chatModel ?? defaults.chatModel,
        thinkingLevel: scope.settings.thinkingLevel,
        language: scope.settings.language,
        timezone: scope.settings.timezone,
      },
    }
  }

  function update(userId: number, body: Record<string, unknown>): OwnSettingsResponse {
    const scope = resolveUserScope(db, userId)
    if (!scope) throw new SettingsValidationError('User not found')
    const global = scope.role === 'admin'
    const patch = parsePatch(body, global)

    if (!global) {
      updateUserSettings(db, userId, patch)
      if (patch.timezone !== undefined) onTimezoneChanged?.(userId)
      return read(userId)
    }

    if (patch.chatModel) {
      try {
        setActiveProvider(patch.chatModel.providerId, patch.chatModel.modelId)
      } catch (err) {
        throw new SettingsValidationError((err as Error).message)
      }
      onActiveProviderChanged?.()
    }
    const settingsUpdate: Record<string, unknown> = {}
    if (patch.thinkingLevel) settingsUpdate.thinkingLevel = patch.thinkingLevel
    if (patch.language) settingsUpdate.language = patch.language.trim()
    if (patch.timezone) settingsUpdate.timezone = patch.timezone
    if (Object.keys(settingsUpdate).length > 0) globalSettings.updateSettings(settingsUpdate)
    return read(userId)
  }

  return { read, update, listChatModels: listSelectableChatModels }
}
