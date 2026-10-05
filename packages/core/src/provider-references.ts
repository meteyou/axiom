import fs from 'node:fs'
import path from 'node:path'
import { getConfigDir } from './config.js'
import { isProviderModelUsable, loadProviders, parseProviderModelId } from './provider-config.js'
import type { ProviderConfig } from './provider-config.js'
import type { ScheduledTaskStore } from './scheduled-task-store.js'

/**
 * `settings.json` fields holding a `providerId[:modelId]` reference for LLM
 * work. TTS/STT references are intentionally absent: disabled providers stay
 * usable there.
 */
const SETTINGS_PROVIDER_REFERENCE_PATHS: ReadonlyArray<readonly string[]> = [
  ['sessionSummaryProviderId'],
  ['factExtraction', 'providerId'],
  ['memoryConsolidation', 'providerId'],
  ['tasks', 'defaultProvider'],
  ['tasks', 'loopDetection', 'smartProvider'],
  ['imageGeneration', 'defaultModel'],
]

export interface ResetDisabledProviderReferencesResult {
  settingsPaths: string[]
  cronjobIds: string[]
}

export function isDisabledProviderReference(value: string | null | undefined, providers: ProviderConfig[]): boolean {
  const { providerId, modelId } = parseProviderModelId(value ?? undefined)
  if (!providerId) return false
  const key = providerId.toLowerCase()
  const provider = providers.find(p => p.id === providerId || p.name.toLowerCase() === key)
  if (!provider) return false
  return !isProviderModelUsable(provider, modelId)
}

function resetSettingsReferences(providers: ProviderConfig[]): string[] {
  const settingsPath = path.join(getConfigDir(), 'settings.json')
  if (!fs.existsSync(settingsPath)) return []

  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>
  const resetPaths: string[] = []

  for (const refPath of SETTINGS_PROVIDER_REFERENCE_PATHS) {
    const parent = refPath.slice(0, -1).reduce<unknown>(
      (node, key) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined),
      settings,
    ) as Record<string, unknown> | undefined
    const leaf = refPath[refPath.length - 1]!
    const value = parent?.[leaf]
    if (typeof value === 'string' && isDisabledProviderReference(value, providers)) {
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
