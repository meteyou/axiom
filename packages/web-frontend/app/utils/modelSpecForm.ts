import type {
  ModelInputModalityContract,
  ModelThinkingLevelContract,
  ModelThinkingLevelMapContract,
} from '@axiom/core/contracts'

export const EDITABLE_THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type EditableThinkingLevel = (typeof EDITABLE_THINKING_LEVELS)[number]

export interface ThinkingLevelRow {
  level: EditableThinkingLevel
  supported: boolean
  /** Provider-specific wire value; empty means "same as the level name". */
  value: string
}

/** pi-ai only enables xhigh/max when explicitly mapped; lower levels are on unless mapped to null. */
function isOptInLevel(level: ModelThinkingLevelContract): boolean {
  return level === 'xhigh' || level === 'max'
}

export function thinkingMapToRows(map: ModelThinkingLevelMapContract | undefined): ThinkingLevelRow[] {
  return EDITABLE_THINKING_LEVELS.map((level) => {
    const mapped = map?.[level]
    const supported = mapped === null ? false : isOptInLevel(level) ? mapped !== undefined : true
    const value = typeof mapped === 'string' && mapped !== level ? mapped : ''
    return { level, supported, value }
  })
}

/**
 * Rebuild a thinking level map from the editor rows. Keys the editor does not
 * render (e.g. `off`) are carried over from `base` unchanged.
 */
export function rowsToThinkingMap(
  rows: ThinkingLevelRow[],
  base?: ModelThinkingLevelMapContract,
): ModelThinkingLevelMapContract | null {
  const map: ModelThinkingLevelMapContract = {}
  if (base && base.off !== undefined) map.off = base.off
  for (const row of rows) {
    const value = row.value.trim()
    if (!row.supported) {
      if (!isOptInLevel(row.level)) map[row.level] = null
    } else if (value) {
      map[row.level] = value
    } else if (isOptInLevel(row.level)) {
      map[row.level] = row.level
    }
  }
  return Object.keys(map).length > 0 ? map : null
}

export function thinkingMapsEqual(
  a: ModelThinkingLevelMapContract | null | undefined,
  b: ModelThinkingLevelMapContract | null | undefined,
): boolean {
  const normalize = (map: ModelThinkingLevelMapContract | null | undefined) =>
    JSON.stringify(Object.entries(map ?? {}).sort(([x], [y]) => x.localeCompare(y)))
  return normalize(a) === normalize(b)
}

export interface ImportedModelSpec {
  name?: string
  contextWindow?: number
  maxTokens?: number
  reasoning?: boolean
  input?: ModelInputModalityContract[]
  thinkingLevelMap?: ModelThinkingLevelMapContract
  /** USD per 1M tokens. */
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
}

const COST_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const

function parseCost(value: unknown): ImportedModelSpec['cost'] {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const cost: NonNullable<ImportedModelSpec['cost']> = {}
  for (const field of COST_FIELDS) {
    const amount = record[field]
    if (typeof amount === 'number' && Number.isFinite(amount) && amount >= 0) cost[field] = amount
  }
  return Object.keys(cost).length > 0 ? cost : undefined
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

function findModelObject(parsed: unknown, modelId: string): Record<string, unknown> | null {
  if (!parsed || typeof parsed !== 'object') return null
  const record = parsed as Record<string, unknown>
  if (Array.isArray(record.models)) {
    const match = record.models.find(m => (m as Record<string, unknown>)?.id === modelId)
    return (match as Record<string, unknown>) ?? null
  }
  if (record.providers && typeof record.providers === 'object') {
    for (const provider of Object.values(record.providers as Record<string, unknown>)) {
      const match = findModelObject(provider, modelId)
      if (match) return match
    }
    return null
  }
  return record
}

/**
 * Parse a pi `models.json` snippet (a single model object, a provider with a
 * `models` array, or a full `{ providers: … }` file) and extract the spec of
 * `modelId`. Returns null when the JSON is invalid or the model is not found.
 */
export function parsePiModelSpec(text: string, modelId: string): ImportedModelSpec | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  const model = findModelObject(parsed, modelId)
  if (!model) return null

  const spec: ImportedModelSpec = {}
  if (typeof model.name === 'string' && model.name.trim()) spec.name = model.name.trim()
  const contextWindow = positiveInteger(model.contextWindow)
  if (contextWindow) spec.contextWindow = contextWindow
  const maxTokens = positiveInteger(model.maxTokens)
  if (maxTokens) spec.maxTokens = maxTokens
  if (typeof model.reasoning === 'boolean') spec.reasoning = model.reasoning
  // pi defaults a missing `input` to text-only.
  const input = Array.isArray(model.input)
    ? model.input.filter((m): m is ModelInputModalityContract => m === 'text' || m === 'image')
    : []
  spec.input = input.includes('image') ? ['text', 'image'] : ['text']
  if (model.thinkingLevelMap && typeof model.thinkingLevelMap === 'object') {
    const map: ModelThinkingLevelMapContract = {}
    for (const [level, value] of Object.entries(model.thinkingLevelMap as Record<string, unknown>)) {
      if (value === null || typeof value === 'string') {
        map[level as ModelThinkingLevelContract] = value
      }
    }
    spec.thinkingLevelMap = map
  }
  const cost = parseCost(model.cost)
  if (cost) spec.cost = cost
  return Object.keys(spec).length > 0 ? spec : null
}
