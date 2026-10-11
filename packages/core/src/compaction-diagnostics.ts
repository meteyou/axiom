import type { CompactionSettingsSource } from './compaction.js'
import { loadConfig, warnConfigReadFailed } from './config.js'

/** `settings.json → compaction`, read fresh; unreadable settings fall back to defaults. */
export function loadCompactionSettings(): CompactionSettingsSource | undefined {
  try {
    return loadConfig<{ compaction?: CompactionSettingsSource }>('settings.json').compaction
  } catch (err) {
    warnConfigReadFailed('settings.json', err)
    return undefined
  }
}
