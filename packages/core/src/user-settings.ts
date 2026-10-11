import type { Database } from './database.js'
import type { SettingsThinkingLevel } from './contracts/settings.js'
import { getDefaultTimezone, loadConfig, warnConfigReadFailed } from './config.js'
import { isValidTimezone } from './cron-parser.js'
import { getProviderDefaultModel, getUsableModels, loadProviders } from './provider-config.js'
import { normalizeThinkingLevel } from './thinking-level.js'

export interface ChatModelRef {
  providerId: string
  modelId: string
}

/** Personal layer of a user's chat settings; `null` means "use the default". */
export interface UserSettingsOverrides {
  chatModel: ChatModelRef | null
  thinkingLevel: SettingsThinkingLevel | null
  language: string | null
  timezone: string | null
}

export interface GlobalChatDefaults {
  chatModel: ChatModelRef | null
  providerName: string | null
  thinkingLevel: SettingsThinkingLevel
  language: string
  timezone: string
}

export interface EffectiveUserSettings {
  /** `null` means the runtime follows the global active model. */
  chatModel: ChatModelRef | null
  thinkingLevel: SettingsThinkingLevel
  language: string
  timezone: string
}

export interface SelectableChatProvider {
  id: string
  name: string
  providerType: string
  models: { id: string; name: string }[]
}

export type UserSettingsPatch = Partial<UserSettingsOverrides>

const DEFAULT_LANGUAGE = 'match'

interface UserSettingsRow {
  chat_provider_id: string | null
  chat_model: string | null
  thinking_level: string | null
  language: string | null
  timezone: string | null
}

export function getGlobalChatDefaults(): GlobalChatDefaults {
  let settings: { thinkingLevel?: string; language?: string; timezone?: string } = {}
  try {
    settings = loadConfig<{ thinkingLevel?: string; language?: string; timezone?: string }>('settings.json')
  } catch (err) {
    warnConfigReadFailed('settings.json', err)
  }

  let chatModel: ChatModelRef | null = null
  let providerName: string | null = null
  try {
    const file = loadProviders()
    const provider = file.providers.find(p => p.id === file.activeProvider)
    if (provider) {
      const modelId = file.activeModel ?? getProviderDefaultModel(provider)
      if (modelId) chatModel = { providerId: provider.id, modelId }
      providerName = provider.name
    }
  } catch (err) {
    warnConfigReadFailed('providers.json', err, 'no default chat model')
  }

  return {
    chatModel,
    providerName,
    thinkingLevel: normalizeThinkingLevel(settings.thinkingLevel) ?? 'off',
    language: settings.language?.trim() || DEFAULT_LANGUAGE,
    timezone: validTimezoneOrNull(settings.timezone) ?? getDefaultTimezone(),
  }
}

function validTimezoneOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed && isValidTimezone(trimmed) ? trimmed : null
}

export function getUserSettingsOverrides(db: Database, userId: number): UserSettingsOverrides {
  const row = db.prepare(
    'SELECT chat_provider_id, chat_model, thinking_level, language, timezone FROM users WHERE id = ?',
  ).get(userId) as UserSettingsRow | undefined
  return {
    chatModel: row?.chat_provider_id && row.chat_model
      ? { providerId: row.chat_provider_id, modelId: row.chat_model }
      : null,
    thinkingLevel: normalizeThinkingLevel(row?.thinking_level) ?? null,
    language: row?.language?.trim() || null,
    timezone: validTimezoneOrNull(row?.timezone),
  }
}

/** Fields left out of `patch` stay untouched; `null` clears the override. */
export function updateUserSettings(db: Database, userId: number, patch: UserSettingsPatch): void {
  const sets: string[] = []
  const values: (string | null)[] = []
  if (patch.chatModel !== undefined) {
    sets.push('chat_provider_id = ?', 'chat_model = ?')
    values.push(patch.chatModel?.providerId ?? null, patch.chatModel?.modelId ?? null)
  }
  if (patch.thinkingLevel !== undefined) {
    sets.push('thinking_level = ?')
    values.push(patch.thinkingLevel)
  }
  if (patch.language !== undefined) {
    sets.push('language = ?')
    values.push(patch.language?.trim() || null)
  }
  if (patch.timezone !== undefined) {
    sets.push('timezone = ?')
    values.push(patch.timezone?.trim() || null)
  }
  if (sets.length === 0) return
  db.prepare(`UPDATE users SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...values, userId)
}

/**
 * Admins (the bootstrap admin included) have no personal layer: the global
 * settings are their settings.
 */
export function resolveEffectiveSettings(
  db: Database,
  user: { id: number; role: string },
): EffectiveUserSettings {
  const defaults = getGlobalChatDefaults()
  if (user.role === 'admin') {
    return { chatModel: null, thinkingLevel: defaults.thinkingLevel, language: defaults.language, timezone: defaults.timezone }
  }
  const overrides = getUserSettingsOverrides(db, user.id)
  return {
    // A model the admin has since disabled or removed falls back to the default.
    chatModel: overrides.chatModel && isOverrideSelectable(overrides.chatModel) ? overrides.chatModel : null,
    thinkingLevel: overrides.thinkingLevel ?? defaults.thinkingLevel,
    language: overrides.language ?? defaults.language,
    timezone: overrides.timezone ?? defaults.timezone,
  }
}

/**
 * Timezone a cronjob or reminder is evaluated in: its owner's effective timezone.
 * Without an owner (legacy rows) the bootstrap admin, i.e. the global timezone, applies.
 */
export function resolveOwnerTimezone(db: Database, ownerUserId: number | null | undefined): string {
  const globalTimezone = getGlobalChatDefaults().timezone
  if (ownerUserId == null) return globalTimezone
  const row = db.prepare('SELECT role FROM users WHERE id = ? AND deleted_at IS NULL').get(ownerUserId) as { role: string } | undefined
  if (!row || row.role === 'admin') return globalTimezone
  return getUserSettingsOverrides(db, ownerUserId).timezone ?? globalTimezone
}

/** Enabled chat models of all usable providers; never exposes credentials. */
export function listSelectableChatModels(): SelectableChatProvider[] {
  const file = loadProviders()
  const out: SelectableChatProvider[] = []
  for (const provider of file.providers) {
    const models = getUsableModels(provider)
    if (models.length === 0) continue
    out.push({
      id: provider.id,
      name: provider.name,
      providerType: provider.providerType,
      models: models.map(id => ({ id, name: provider.models?.find(m => m.id === id)?.name ?? id })),
    })
  }
  return out
}

export function isSelectableChatModel(ref: ChatModelRef): boolean {
  return listSelectableChatModels().some(p => p.id === ref.providerId && p.models.some(m => m.id === ref.modelId))
}

function isOverrideSelectable(ref: ChatModelRef): boolean {
  try {
    return isSelectableChatModel(ref)
  } catch {
    return false
  }
}

/** Language hint for speech-to-text; `undefined` lets the provider auto-detect. */
export function toSttLanguage(language: string | null | undefined): string | undefined {
  const trimmed = (language ?? '').trim()
  return ['match', 'auto', ''].includes(trimmed.toLowerCase()) ? undefined : trimmed
}
