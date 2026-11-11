import fs from 'node:fs'
import path from 'node:path'
import { getConfigDir } from './config.js'
import { isProviderImageModelUsable, isProviderModelUsable, isProviderVoiceModelUsable, loadProviders, parseProviderModelId } from './provider-config.js'
import type { ProviderConfig } from './provider-config.js'
import type { ScheduledTaskStore } from './scheduled-task-store.js'

type ReferenceKind = 'text' | 'image' | 'stt' | 'tts'
type VoiceReferenceKind = 'stt' | 'tts'

interface SettingsReference {
  path: readonly string[]
  kind?: ReferenceKind
}

/** `settings.json` fields holding a `providerId[:modelId]` model reference. */
const SETTINGS_PROVIDER_REFERENCE_PATHS: readonly SettingsReference[] = [
  { path: ['sessionSummaryProviderId'] },
  { path: ['factExtraction', 'providerId'] },
  { path: ['memoryConsolidation', 'providerId'] },
  { path: ['tasks', 'defaultProvider'] },
  { path: ['tasks', 'loopDetection', 'smartProvider'] },
  { path: ['stt', 'rewrite', 'providerId'] },
  { path: ['imageGeneration', 'defaultModel'], kind: 'image' },
  { path: ['stt', 'model'], kind: 'stt' },
  { path: ['tts', 'model'], kind: 'tts' },
]

export interface ResetDisabledProviderReferencesResult {
  settingsPaths: string[]
  cronjobIds: string[]
}

function findReferencedProvider(value: string | null | undefined, providers: ProviderConfig[]) {
  const { providerId, modelId } = parseProviderModelId(value ?? undefined)
  if (!providerId) return undefined
  const key = providerId.toLowerCase()
  const provider = providers.find(p => p.id === providerId || p.name.toLowerCase() === key)
  return provider ? { provider, modelId } : undefined
}

export function isDisabledProviderReference(value: string | null | undefined, providers: ProviderConfig[]): boolean {
  const ref = findReferencedProvider(value, providers)
  return ref ? !isProviderModelUsable(ref.provider, ref.modelId) : false
}

function isDisabledModelReference(value: string, providers: ProviderConfig[], kind: ReferenceKind): boolean {
  if (kind === 'text') return isDisabledProviderReference(value, providers)
  const ref = findReferencedProvider(value, providers)
  if (!ref?.modelId) return false
  if (kind === 'image') return !isProviderImageModelUsable(ref.provider, ref.modelId)
  return !isProviderVoiceModelUsable(ref.provider, kind, ref.modelId)
}

/** Unlike a disabled reference, this also covers a model or provider that was removed. */
function isUnusableVoiceReference(value: string, providers: ProviderConfig[], kind: VoiceReferenceKind): boolean {
  if (!value) return false
  const ref = findReferencedProvider(value, providers)
  return !ref?.modelId || !isProviderVoiceModelUsable(ref.provider, kind, ref.modelId)
}

function resetSettingsReferences(
  isStale: (value: string, kind: ReferenceKind) => boolean,
  references: readonly SettingsReference[] = SETTINGS_PROVIDER_REFERENCE_PATHS,
): string[] {
  const settingsPath = path.join(getConfigDir(), 'settings.json')
  if (!fs.existsSync(settingsPath)) return []

  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>
  const resetPaths: string[] = []

  for (const { path: refPath, kind = 'text' } of references) {
    const parent = refPath.slice(0, -1).reduce<unknown>(
      (node, key) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined),
      settings,
    ) as Record<string, unknown> | undefined
    const leaf = refPath[refPath.length - 1]!
    const value = parent?.[leaf]
    if (typeof value === 'string' && isStale(value, kind)) {
      parent![leaf] = ''
      resetPaths.push(refPath.join('.'))
    }
  }

  if (resetPaths.length > 0) {
    fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf-8')
  }
  return resetPaths
}

function resetCronjobReferences(store: ScheduledTaskStore, providers: ProviderConfig[]): string[] {
  const resetIds: string[] = []
  for (const job of store.list()) {
    if (job.provider && isDisabledProviderReference(job.provider, providers)) {
      store.update(job.id, { provider: '' })
      resetIds.push(job.id)
    }
  }
  return resetIds
}

/**
 * Reset every stored LLM provider/model reference that points at a disabled
 * provider or model back to its default (empty value).
 */
export function resetDisabledProviderReferences(
  options: { scheduledTaskStore?: ScheduledTaskStore } = {},
): ResetDisabledProviderReferencesResult {
  const providers = loadProviders().providers
  return {
    settingsPaths: resetSettingsReferences((value, kind) => isDisabledModelReference(value, providers, kind)),
    cronjobIds: options.scheduledTaskStore ? resetCronjobReferences(options.scheduledTaskStore, providers) : [],
  }
}

/**
 * Clear `stt.model` / `tts.model` when the selected model or its provider no
 * longer exists or is disabled. Returns the reset settings paths.
 */
export function resetUnusableVoiceModelReferences(): string[] {
  const providers = loadProviders().providers
  return resetSettingsReferences(
    (value, kind) => isUnusableVoiceReference(value, providers, kind as VoiceReferenceKind),
    SETTINGS_PROVIDER_REFERENCE_PATHS.filter(reference => reference.kind === 'stt' || reference.kind === 'tts'),
  )
}
