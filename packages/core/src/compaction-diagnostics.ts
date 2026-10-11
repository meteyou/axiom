import { getCompactionWarningScopes } from './compaction.js'
import type { CompactionSettingsSource } from './compaction.js'
import { loadConfig, warnConfigReadFailed } from './config.js'
import { buildModel, getModelCompactionOverride, getUsableModels } from './provider-config.js'
import type { ProviderConfig } from './provider-config.js'

/** `settings.json → compaction`, read fresh; unreadable settings fall back to defaults. */
export function loadCompactionSettings(): CompactionSettingsSource | undefined {
  try {
    return loadConfig<{ compaction?: CompactionSettingsSource }>('settings.json').compaction
  } catch (err) {
    warnConfigReadFailed('settings.json', err)
    return undefined
  }
}

const SCOPE_LABELS = { interactive: 'main chat', task: 'background tasks' } as const

/**
 * Human-readable warnings for every usable model whose context window is too
 * small for compaction to leave headroom, given these compaction settings.
 */
export function listCompactionWarnings(
  providers: readonly ProviderConfig[],
  settings: CompactionSettingsSource | undefined,
): string[] {
  const warnings: string[] = []
  for (const provider of providers) {
    for (const modelId of getUsableModels(provider)) {
      let contextWindow: number
      try {
        contextWindow = buildModel(provider, modelId).contextWindow
      } catch {
        continue
      }
      const scopes = getCompactionWarningScopes(contextWindow, settings, getModelCompactionOverride(provider, modelId))
      if (scopes.length === 0) continue
      warnings.push(`${provider.name} / ${modelId}: a ${contextWindow}-token context window is too small for the `
        + `system prompt plus compaction summary and kept tail (${scopes.map(s => SCOPE_LABELS[s]).join(', ')}).`)
    }
  }
  return warnings
}
