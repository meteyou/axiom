import fs from 'node:fs'
import path from 'node:path'
import { getConfigDir, warnConfigReadFailed } from './config.js'
import { decrypt, isEncrypted } from './encryption.js'
import { addProvider, loadProviders, loadProvidersDecrypted, saveProviders } from './provider-config.js'
import type { ProviderConfig } from './provider-config.js'
import { getVoiceBackendId, supportsVoiceModels } from './voice-capabilities.js'
import type { VoiceModelKind } from './voice-capabilities.js'

type Logger = Pick<Console, 'log' | 'warn'>
type VoiceBlock = Record<string, unknown>

const LEGACY_KEYS: Record<VoiceModelKind, readonly string[]> = {
  tts: ['provider', 'providerId', 'openaiModel', 'openaiVoice', 'openaiInstructions', 'mistralVoice', 'deepgramModel', 'deepgramApiKey'],
  stt: ['provider', 'providerId', 'whisperUrl', 'openaiModel', 'ollamaModel', 'deepgramModel', 'deepgramLanguage', 'deepgramApiKey'],
}

const LEGACY_DEFAULT_MODELS = {
  tts: { openai: 'gpt-4o-mini-tts', mistral: 'voxtral-mini-tts-2603', deepgram: 'aura-2-thalia-en' },
  stt: { openai: 'whisper-1', deepgram: 'nova-3' },
} as const

const LEGACY_BASE_URL_HINTS: Record<string, string> = {
  openai: 'api.openai.com',
  mistral: 'api.mistral.ai',
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function hasLegacyKeys(kind: VoiceModelKind, block: VoiceBlock): boolean {
  return LEGACY_KEYS[kind].some(key => key in block)
}

const PLAINTEXT_DEEPGRAM_KEY = /^[0-9a-f]{40}$/i

function decryptLegacyKey(raw: string): string {
  if (!raw || !isEncrypted(raw)) return raw
  try {
    return decrypt(raw)
  } catch (err) {
    // Plaintext Deepgram keys (40 hex chars) pass the isEncrypted() heuristic.
    if (PLAINTEXT_DEEPGRAM_KEY.test(raw)) return raw
    // Storing the ciphertext as the key would lose the original once the legacy settings are dropped.
    throw new Error(`the legacy Deepgram API key cannot be decrypted (was ENCRYPTION_KEY changed?), keeping the legacy settings: ${(err as Error).message}`)
  }
}

function uniqueProviderName(base: string): string {
  const taken = new Set(loadProviders().providers.map(p => p.name))
  if (!taken.has(base)) return base
  for (let i = 2; ; i++) {
    const name = `${base} ${i}`
    if (!taken.has(name)) return name
  }
}

function ensureDeepgramProvider(apiKey: string): ProviderConfig {
  const existing = loadProvidersDecrypted().providers.find(p => p.providerType === 'deepgram' && p.apiKey === apiKey)
  if (existing) return existing
  return addProvider({ name: uniqueProviderName('Deepgram'), providerType: 'deepgram', apiKey, enabledModels: [] })
}

/** Mirrors the provider lookup of the pre-provider TTS/STT dispatchers. */
function findLegacyProvider(kind: VoiceModelKind, legacyProvider: string, providerId: string): ProviderConfig | null {
  const providers = loadProviders().providers
  if (providerId) return providers.find(p => p.id === providerId) ?? null
  if (kind === 'stt') return null
  const hint = LEGACY_BASE_URL_HINTS[legacyProvider]
  return providers.find(p => p.providerType === legacyProvider || p.provider === legacyProvider)
    ?? providers.find(p => hint && p.baseUrl?.includes(hint))
    ?? null
}

function enableVoiceModel(providerId: string, kind: VoiceModelKind, modelId: string): void {
  const file = loadProviders()
  const provider = file.providers.find(p => p.id === providerId)
  if (!provider) return
  const key = kind === 'stt' ? 'enabledSttModels' : 'enabledTtsModels'
  const models = provider[key] ?? []
  if (models.includes(modelId)) return
  provider[key] = [...models, modelId]
  saveProviders(file)
}

function migrateDeepgram(kind: VoiceModelKind, block: VoiceBlock): boolean {
  const apiKey = decryptLegacyKey(str(block.deepgramApiKey))
  if (!apiKey) return false
  const provider = ensureDeepgramProvider(apiKey)
  const modelId = str(block.deepgramModel) || LEGACY_DEFAULT_MODELS[kind].deepgram
  enableVoiceModel(provider.id, kind, modelId)
  block.model = `${provider.id}:${modelId}`
  if (kind === 'stt' && !str(block.language)) block.language = str(block.deepgramLanguage)
  return true
}

function whisperBaseUrl(url: string): string | null {
  const match = /^(https?:\/\/.+\/v\d+)\/audio\/transcriptions\/?$/i.exec(url)
  return match ? match[1] : null
}

/**
 * The old backend posted to a full endpoint URL without a model id, so the
 * server is kept as a provider but no model is guessed. Returns false when
 * the URL could not be turned into a provider.
 */
function migrateWhisperUrl(block: VoiceBlock, logger: Logger): boolean {
  const url = str(block.whisperUrl)
  if (!url) {
    if (block.enabled === true) logger.warn('[axiom] STT migration: no Whisper URL configured, select an STT model in Settings')
    return true
  }
  const baseUrl = whisperBaseUrl(url)
  if (!baseUrl) {
    logger.warn(`[axiom] STT migration: Whisper URL "${url}" is not an OpenAI-compatible /v1/audio/transcriptions endpoint, keeping the legacy settings; add the server as a custom provider and select an STT model in Settings`)
    return false
  }
  const existing = loadProviders().providers.find(p => getVoiceBackendId(p.providerType) === 'openai-compatible' && p.baseUrl.replace(/\/+$/, '') === baseUrl)
  const provider = existing ?? addProvider({ name: uniqueProviderName('Whisper'), providerType: 'custom-openai-completions', baseUrl, enabledModels: [] })
  const action = existing ? 'matches the existing provider' : 'added as provider'
  logger.warn(`[axiom] STT migration: Whisper server ${action} "${provider.name}", add an STT model to it and select it in Settings`)
  return true
}

function resolveVoiceProvider(kind: VoiceModelKind, legacyProvider: string, providerId: string, logger: Logger): ProviderConfig | null {
  const label = kind.toUpperCase()
  const provider = findLegacyProvider(kind, legacyProvider, providerId)
  if (!provider) {
    logger.warn(`[axiom] ${label} migration: provider "${providerId || legacyProvider}" not found, select a model in Settings`)
    return null
  }
  if (!supportsVoiceModels(provider.providerType)) {
    logger.warn(`[axiom] ${label} migration: provider "${provider.name}" (${provider.providerType}) has no ${label} models, select a model in Settings`)
    return null
  }
  return provider
}

function migrateTtsVoice(legacyProvider: 'openai' | 'mistral', block: VoiceBlock): void {
  if (!str(block.voice)) block.voice = legacyProvider === 'openai' ? str(block.openaiVoice) || 'nova' : str(block.mistralVoice)
  if (legacyProvider === 'openai' && !str(block.instructions)) block.instructions = str(block.openaiInstructions)
}

function migrateProviderBacked(kind: VoiceModelKind, legacyProvider: 'openai' | 'mistral', block: VoiceBlock, logger: Logger): boolean {
  const providerId = str(block.providerId)
  // Untouched defaults (disabled, no explicit provider) must not add voice models to a chat provider.
  if (block.enabled !== true && !providerId) return false

  const provider = resolveVoiceProvider(kind, legacyProvider, providerId, logger)
  if (!provider) return false

  const defaults = LEGACY_DEFAULT_MODELS[kind] as Partial<Record<string, string>>
  const modelId = (legacyProvider === 'openai' ? str(block.openaiModel) : '') || defaults[legacyProvider]
  if (!modelId) return false
  enableVoiceModel(provider.id, kind, modelId)
  block.model = `${provider.id}:${modelId}`
  if (kind === 'tts') migrateTtsVoice(legacyProvider, block)
  return true
}

/** Returns false when the legacy keys must be kept because they hold data that could not be migrated. */
function migrateBlock(kind: VoiceModelKind, block: VoiceBlock, logger: Logger): boolean {
  if (str(block.model)) return true
  const legacyProvider = str(block.provider) || (kind === 'stt' ? 'whisper-url' : 'openai')

  let migrated = false
  if (legacyProvider === 'deepgram') migrated = migrateDeepgram(kind, block)
  else if (legacyProvider === 'openai' || legacyProvider === 'mistral') migrated = migrateProviderBacked(kind, legacyProvider, block, logger)
  else if (kind === 'stt' && legacyProvider === 'whisper-url') {
    if (!migrateWhisperUrl(block, logger)) return false
  } else if (block.enabled === true) {
    logger.warn(`[axiom] STT backend "${legacyProvider}" is no longer supported, select an STT model in Settings`)
  }

  if (migrated) logger.log(`[axiom] Migrated ${kind.toUpperCase()} settings to model "${String(block.model)}"`)
  if (legacyProvider === 'deepgram' && !migrated && str(block.deepgramApiKey)) {
    logger.warn(`[axiom] ${kind.toUpperCase()} migration: the legacy Deepgram API key could not be migrated, keeping the legacy settings`)
    return false
  }
  return true
}

/**
 * One-time upgrade of the pre-provider `tts`/`stt` settings (backend-specific
 * keys, Deepgram keys inside settings.json) to `providerId:modelId` voice
 * models. The legacy keys are dropped afterwards, so this runs only once.
 */
export function migrateLegacyVoiceSettings(logger: Logger = console): void {
  const settingsPath = path.join(getConfigDir(), 'settings.json')
  if (!fs.existsSync(settingsPath)) return

  let settings: Record<string, unknown>
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>
  } catch (err) {
    // A throw here aborts the startup; the legacy keys stay on disk, so the migration runs once the file is fixed.
    warnConfigReadFailed('settings.json', err, 'skipping the voice settings migration')
    return
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return
  let changed = false
  for (const kind of ['stt', 'tts'] as const) {
    const block = settings[kind]
    if (!block || typeof block !== 'object' || !hasLegacyKeys(kind, block as VoiceBlock)) continue
    const voiceBlock = block as VoiceBlock
    try {
      if (!migrateBlock(kind, voiceBlock, logger)) continue
    } catch (err) {
      logger.warn(`[axiom] ${kind.toUpperCase()} settings migration failed: ${(err as Error).message}`)
      continue
    }
    for (const key of LEGACY_KEYS[kind]) delete voiceBlock[key]
    changed = true
  }

  if (changed) fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf-8')
}
