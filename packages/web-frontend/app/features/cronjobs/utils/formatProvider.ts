export interface ProviderLike {
  id: string
  name: string
  enabledModels?: string[]
}

/**
 * Format a stored cronjob provider value for display. Accepts both the modern
 * `providerId:modelId` composite and the legacy plain provider name/id.
 * Returns the provider name (with model in parens when known), or the raw
 * value when the provider cannot be resolved.
 */
export function formatCronjobProvider(raw: string | null | undefined, providers: ProviderLike[]): string {
  if (!raw) return ''
  const colonIdx = raw.indexOf(':')
  const providerKey = colonIdx === -1 ? raw : raw.slice(0, colonIdx)
  const modelId = colonIdx === -1 ? undefined : raw.slice(colonIdx + 1) || undefined
  const match = providers.find(
    p => p.id === providerKey || p.name.toLowerCase() === providerKey.toLowerCase(),
  )
  if (!match) return raw
  const model = modelId ?? match.enabledModels?.[0]
  return model ? `${match.name} (${model})` : match.name
}
