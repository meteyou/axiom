import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  SETTINGS_THINKING_LEVELS,
  type ProviderModelSpecContract,
  type SettingsThinkingLevel,
} from '@axiom/core/contracts'

interface ProviderWithSpecs {
  id: string
  enabledModels?: string[]
  modelSpecs?: Record<string, ProviderModelSpecContract>
}

/** Look up the effective spec of a `providerId:modelId` composite (or the provider's first model). */
export function findModelSpec(
  providers: ProviderWithSpecs[],
  providerId: string | null | undefined,
  modelId?: string | null,
): ProviderModelSpecContract | undefined {
  if (!providerId) return undefined
  const provider = providers.find(p => p.id === providerId)
  const id = modelId || provider?.enabledModels?.[0]
  return id ? provider?.modelSpecs?.[id] : undefined
}

export function findModelSpecByComposite(
  providers: ProviderWithSpecs[],
  composite: string | null | undefined,
): ProviderModelSpecContract | undefined {
  if (!composite) return undefined
  const colon = composite.indexOf(':')
  return colon === -1
    ? findModelSpec(providers, composite)
    : findModelSpec(providers, composite.slice(0, colon), composite.slice(colon + 1))
}

export interface ThinkingLevelChoices {
  /** Levels the model supports, in ascending order. All levels when the model is unknown. */
  levels: SettingsThinkingLevel[]
  /** The level the model actually runs with for the configured one. */
  effective: SettingsThinkingLevel
}

export function getThinkingLevelChoices(
  spec: ProviderModelSpecContract | undefined,
  current: SettingsThinkingLevel,
): ThinkingLevelChoices {
  if (!spec) return { levels: [...SETTINGS_THINKING_LEVELS], effective: current }
  const levels = getSupportedThinkingLevels(spec)
    .filter((level): level is SettingsThinkingLevel => (SETTINGS_THINKING_LEVELS as readonly string[]).includes(level))
  return { levels, effective: clampThinkingLevel(spec, current) as SettingsThinkingLevel }
}

export interface ThinkingLevelSelectOption {
  value: SettingsThinkingLevel
  label: string
}

/**
 * Select options for a thinking level: the levels the model supports, plus the
 * current value when it is not supported (labelled with the level it runs as),
 * so the select never shows an empty value.
 */
export function buildThinkingLevelSelectOptions(
  spec: ProviderModelSpecContract | undefined,
  current: SettingsThinkingLevel | '' | null | undefined,
  label: (level: SettingsThinkingLevel) => string,
  unsupportedLabel: (level: SettingsThinkingLevel, effective: SettingsThinkingLevel) => string,
): ThinkingLevelSelectOption[] {
  const selected = current || undefined
  const { levels, effective } = getThinkingLevelChoices(spec, selected ?? 'off')
  return SETTINGS_THINKING_LEVELS
    .filter(value => levels.includes(value) || value === selected)
    .map(value => ({
      value,
      label: levels.includes(value) ? label(value) : unsupportedLabel(value, effective),
    }))
}
