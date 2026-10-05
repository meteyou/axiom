import fs from 'node:fs'
import path from 'node:path'
import { getConfigDir } from './config.js'
import { isProviderImageModelUsable, isProviderModelUsable, loadProviders, parseProviderModelId } from './provider-config.js'
import type { ProviderConfig } from './provider-config.js'
import type { ScheduledTaskStore } from './scheduled-task-store.js'

/**
 * `settings.json` fields holding a `providerId[:modelId]` reference for LLM
 * work. TTS/STT references are intentionally absent: disabled providers stay
 * usable there.
 */
const SETTINGS_PROVIDER_REFERENCE_PATHS: ReadonlyArray<{ path: readonly string[]; image?: true }> = [
  { path: ['sessionSummaryProviderId'] },
  { path: ['factExtraction', 'providerId'] },
  { path: ['memoryConsolidation', 'providerId'] },
  { path: ['tasks', 'defaultProvider'] },
  { path: ['tasks', 'loopDetection', 'smartProvider'] },
  { path: ['imageGeneration', 'defaultModel'], image: true },
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

function isDisabledImageModelReference(value: string, providers: ProviderConfig[]): boolean {
  const ref = findReferencedProvider(value, providers)
  if (!ref?.modelId) return false
  return !isProviderImageModelUsable(ref.provider, ref.modelId)
}

function resetSettingsReferences(providers: ProviderConfig[]): string[] {
  const settingsPath = path.join(getConfigDir(), 'settings.json')
  if (!fs.existsSync(settingsPath)) return []

  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>
  const resetPaths: string[] = []

  for (const { path: refPath, image } of SETTINGS_PROVIDER_REFERENCE_PATHS) {
    const parent = refPath.slice(0, -1).reduce<unknown>(
      (node, key) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined),
      settings,
    ) as Record<string, unknown> | undefined
    const leaf = refPath[refPath.length - 1]!
    const value = parent?.[leaf]
    const isDisabled = image ? isDisabledImageModelReference : isDisabledProviderReference
    if (typeof value === 'string' && isDisabled(value, providers)) {
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
    settingsPaths: resetSettingsReferences(providers),
    cronjobIds: options.scheduledTaskStore ? resetCronjobReferences(options.scheduledTaskStore, providers) : [],
  }
}
