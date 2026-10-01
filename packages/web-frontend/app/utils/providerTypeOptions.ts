interface PresetLike {
  label: string
}

type Translate = (key: string) => string

/** Translated provider type label (`providers.providerTypes.<key>`), falling back to the backend label. */
export function providerTypeLabel(presetKey: string, preset: PresetLike | undefined, t: Translate): string {
  const translationKey = `providers.providerTypes.${presetKey}`
  const translated = t(translationKey)
  return translated && translated !== translationKey ? translated : preset?.label ?? presetKey
}

export interface ProviderTypeOption {
  value: string
  label: string
}

/** Select options for the given presets, sorted by their display label. */
export function buildProviderTypeOptions(presets: Array<[string, PresetLike]>, t: Translate): ProviderTypeOption[] {
  return presets
    .map(([key, preset]) => ({ value: key, label: providerTypeLabel(key, preset, t) }))
    .sort((a, b) => a.label.localeCompare(b.label))
}
