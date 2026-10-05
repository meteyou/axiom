import { URL } from 'node:url'
import { MODEL_THINKING_LEVELS, PROVIDER_TYPE_PRESETS } from '@axiom/core'
import type {
  ModelInputModalityContract,
  ModelThinkingLevelMapContract,
  ProviderCreatePayloadContract,
  ProviderFallbackUpdatePayloadContract,
  ProviderModelSelectionPayloadContract,
  ProviderModelUpdatePayloadContract,
  ProviderOAuthCodePayloadContract,
  ProviderOAuthLoginStartPayloadContract,
  ProviderTypePresetContract,
  ProviderUpdatePayloadContract,
} from '@axiom/core/contracts'

const VALID_PROVIDER_TYPES = Object.keys(PROVIDER_TYPE_PRESETS)

export const OLLAMA_REQUEST_TIMEOUT_MS = 15_000

interface ParseSuccess<T> {
  ok: true
  value: T
}

interface ParseFailure {
  ok: false
  error: string
}

export type ParseResult<T> = ParseSuccess<T> | ParseFailure

function toRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object') {
    return value as Record<string, unknown>
  }

  return {}
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

function normalizeEnabledModels(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value
    .map((entry) => String(entry).trim())
    .filter(Boolean)
}

function normalizeDegradedThresholdMs(value: unknown): number | undefined {
  if (value == null) return undefined
  return Math.max(1, Math.round(value as number))
}

function normalizeExtraFields(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const out: Record<string, string> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'string') out[key] = raw.trim()
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function normalizeTextVerbosity(value: unknown): 'low' | 'medium' | 'high' | null | undefined {
  if (value === null || value === '') return null
  if (value === 'low' || value === 'medium' || value === 'high') return value
  return undefined
}

function normalizeTransport(
  value: unknown,
): 'sse' | 'websocket' | 'websocket-cached' | 'auto' | null | undefined {
  if (value === null || value === '') return null
  if (value === 'sse' || value === 'websocket' || value === 'websocket-cached' || value === 'auto') {
    return value
  }
  return undefined
}

/** `undefined` = not sent, `null` = clear; an object is validated against the preset's API in core. */
function parseCompatField(body: Record<string, unknown>): ParseResult<Record<string, unknown> | null | undefined> {
  if (!Object.prototype.hasOwnProperty.call(body, 'compat')) return { ok: true, value: undefined }
  const raw = body.compat
  if (raw === null) return { ok: true, value: null }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'compat must be a JSON object or null' }
  return { ok: true, value: raw as Record<string, unknown> }
}

function isValidProviderType(providerType: string): boolean {
  return VALID_PROVIDER_TYPES.includes(providerType)
}

export function parseProviderTypeParam(providerType: unknown): ParseResult<string> {
  const parsed = typeof providerType === 'string' ? providerType : String(providerType ?? '')
  if (!isValidProviderType(parsed)) {
    return {
      ok: false,
      error: `Invalid provider type. Must be one of: ${VALID_PROVIDER_TYPES.join(', ')}`,
    }
  }

  return { ok: true, value: parsed }
}

export function parseProviderModelSelectionPayload(payload: unknown): ProviderModelSelectionPayloadContract {
  const body = toRecord(payload)
  return {
    modelId: body.modelId as string | undefined,
    ...(body.modelType === 'image' && { modelType: 'image' as const }),
  }
}

function asCostNumber(value: unknown): number | undefined {
  if (value === null || value === '' || value === undefined) return undefined
  const num = Number(value)
  if (!Number.isFinite(num) || num < 0) return undefined
  return num
}

/** `null` clears the override (the field follows the catalog again). */
function parseModelCostPatch(value: unknown): ProviderModelUpdatePayloadContract['cost'] {
  const body = toRecord(value)
  const cost: NonNullable<ProviderModelUpdatePayloadContract['cost']> = {}
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
    if (body[key] === null) {
      cost[key] = null
      continue
    }
    const parsed = asCostNumber(body[key])
    if (parsed !== undefined) cost[key] = parsed
  }
  return Object.keys(cost).length > 0 ? cost : undefined
}

function parseOptionalStringField(body: Record<string, unknown>, key: 'name' | 'description'): ParseResult<string | undefined> {
  if (!Object.prototype.hasOwnProperty.call(body, key)) return { ok: true, value: undefined }
  if (typeof body[key] !== 'string') return { ok: false, error: `${key} must be a string` }
  return { ok: true, value: body[key] }
}

function parseOptionalBooleanField(body: Record<string, unknown>, key: 'disabled'): ParseResult<boolean | undefined> {
  if (!Object.prototype.hasOwnProperty.call(body, key)) return { ok: true, value: undefined }
  if (typeof body[key] !== 'boolean') return { ok: false, error: `${key} must be a boolean` }
  return { ok: true, value: body[key] }
}

function parseOptionalNullableBoolean(body: Record<string, unknown>, key: 'reasoning'): ParseResult<boolean | null | undefined> {
  if (!Object.prototype.hasOwnProperty.call(body, key)) return { ok: true, value: undefined }
  if (body[key] === null) return { ok: true, value: null }
  if (typeof body[key] !== 'boolean') return { ok: false, error: `${key} must be a boolean or null` }
  return { ok: true, value: body[key] }
}

const MODEL_UPDATE_FIELDS = [
  'name', 'description', 'contextWindow', 'maxTokens', 'reasoning', 'input', 'output', 'thinkingLevelMap', 'disabled',
] as const

function parseOptionalPositiveInteger(
  body: Record<string, unknown>,
  key: 'contextWindow' | 'maxTokens',
): ParseResult<number | null | undefined> {
  if (!Object.prototype.hasOwnProperty.call(body, key)) return { ok: true, value: undefined }
  if (body[key] === null) return { ok: true, value: null }
  const value = Number(body[key])
  if (!Number.isInteger(value) || value <= 0) {
    return { ok: false, error: `${key} must be a positive integer` }
  }
  return { ok: true, value }
}

const MODEL_INPUT_MODALITIES: readonly ModelInputModalityContract[] = ['text', 'image']

function parseOptionalModelInput(body: Record<string, unknown>): ParseResult<ModelInputModalityContract[] | null | undefined> {
  if (!Object.prototype.hasOwnProperty.call(body, 'input')) return { ok: true, value: undefined }
  const raw = body.input
  if (raw === null) return { ok: true, value: null }
  if (!Array.isArray(raw) || !raw.every(entry => MODEL_INPUT_MODALITIES.includes(entry))) {
    return { ok: false, error: `input must be an array of ${MODEL_INPUT_MODALITIES.join(', ')}` }
  }
  const input = [...new Set(raw as ModelInputModalityContract[])]
  if (!input.includes('text')) return { ok: false, error: 'input must include text' }
  return { ok: true, value: input }
}

function parseOptionalModelOutput(body: Record<string, unknown>): ParseResult<ModelInputModalityContract[] | null | undefined> {
  if (!Object.prototype.hasOwnProperty.call(body, 'output')) return { ok: true, value: undefined }
  const raw = body.output
  if (raw === null) return { ok: true, value: null }
  if (!Array.isArray(raw) || !raw.every(entry => MODEL_INPUT_MODALITIES.includes(entry))) {
    return { ok: false, error: `output must be an array of ${MODEL_INPUT_MODALITIES.join(', ')}` }
  }
  const output = [...new Set(raw as ModelInputModalityContract[])]
  if (!output.includes('image')) return { ok: false, error: 'output must include image' }
  return { ok: true, value: output }
}

function parseOptionalThinkingLevelMap(
  body: Record<string, unknown>,
): ParseResult<ModelThinkingLevelMapContract | null | undefined> {
  if (!Object.prototype.hasOwnProperty.call(body, 'thinkingLevelMap')) return { ok: true, value: undefined }
  const raw = body.thinkingLevelMap
  if (raw === null) return { ok: true, value: null }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'thinkingLevelMap must be an object or null' }
  }
  const map: ModelThinkingLevelMapContract = {}
  for (const [level, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!(MODEL_THINKING_LEVELS as readonly string[]).includes(level)) {
      return { ok: false, error: `thinkingLevelMap has unknown level "${level}"` }
    }
    if (value !== null && (typeof value !== 'string' || !value.trim())) {
      return { ok: false, error: `thinkingLevelMap.${level} must be a non-empty string or null` }
    }
    map[level as keyof ModelThinkingLevelMapContract] = value === null ? null : value.trim()
  }
  return { ok: true, value: map }
}

export function parseProviderModelUpdatePayload(payload: unknown): ParseResult<ProviderModelUpdatePayloadContract> {
  const body = toRecord(payload)
  const hasCost = typeof body.cost === 'object' && body.cost !== null
  const hasAnyField = hasCost || MODEL_UPDATE_FIELDS.some(key => Object.prototype.hasOwnProperty.call(body, key))
  if (!hasAnyField) {
    return { ok: false, error: `Provide at least one of ${MODEL_UPDATE_FIELDS.join(', ')} or cost to update.` }
  }

  const disabled = parseOptionalBooleanField(body, 'disabled')
  if (!disabled.ok) return disabled

  const name = parseOptionalStringField(body, 'name')
  if (!name.ok) return name
  const description = parseOptionalStringField(body, 'description')
  if (!description.ok) return description
  const contextWindow = parseOptionalPositiveInteger(body, 'contextWindow')
  if (!contextWindow.ok) return contextWindow
  const maxTokens = parseOptionalPositiveInteger(body, 'maxTokens')
  if (!maxTokens.ok) return maxTokens
  const reasoning = parseOptionalNullableBoolean(body, 'reasoning')
  if (!reasoning.ok) return reasoning
  const input = parseOptionalModelInput(body)
  if (!input.ok) return input
  const output = parseOptionalModelOutput(body)
  if (!output.ok) return output
  const thinkingLevelMap = parseOptionalThinkingLevelMap(body)
  if (!thinkingLevelMap.ok) return thinkingLevelMap

  const value: ProviderModelUpdatePayloadContract = {}
  if (disabled.value !== undefined) value.disabled = disabled.value
  if (name.value !== undefined) value.name = name.value
  if (description.value !== undefined) value.description = description.value
  if (contextWindow.value !== undefined) value.contextWindow = contextWindow.value
  if (maxTokens.value !== undefined) value.maxTokens = maxTokens.value
  if (reasoning.value !== undefined) value.reasoning = reasoning.value
  if (input.value !== undefined) value.input = input.value
  if (output.value !== undefined) value.output = output.value
  if (thinkingLevelMap.value !== undefined) value.thinkingLevelMap = thinkingLevelMap.value
  const cost = hasCost ? parseModelCostPatch(body.cost) : undefined
  if (cost) value.cost = cost

  if (Object.keys(value).length === 0) {
    return { ok: false, error: 'No valid fields to update.' }
  }

  return { ok: true, value }
}

export function parseFallbackPayload(payload: unknown): ParseResult<ProviderFallbackUpdatePayloadContract> {
  const body = toRecord(payload)
  const providerId = body.providerId

  if (providerId === null || providerId === undefined) {
    return {
      ok: true,
      value: {
        providerId: null,
        modelId: (body.modelId as string | null | undefined) ?? null,
      },
    }
  }

  if (typeof providerId !== 'string' || !providerId.trim()) {
    return { ok: false, error: 'providerId must be a non-empty string or null' }
  }

  return {
    ok: true,
    value: {
      providerId: providerId.trim(),
      modelId: (body.modelId as string | null | undefined) ?? null,
    },
  }
}

export function parseOAuthLoginPayload(payload: unknown): ParseResult<ProviderOAuthLoginStartPayloadContract> {
  const body = toRecord(payload)
  const providerType = asTrimmedString(body.providerType)
  const name = asTrimmedString(body.name)
  const enabledModels = normalizeEnabledModels(body.enabledModels) ?? []

  if (!providerType || !isValidProviderType(providerType)) {
    return { ok: false, error: 'Invalid provider type' }
  }

  if (!name) {
    return { ok: false, error: 'Provider name is required' }
  }

  return {
    ok: true,
    value: {
      providerType,
      name,
      enabledModels,
      providerId: asTrimmedString(body.providerId),
      textVerbosity: normalizeTextVerbosity(body.textVerbosity),
      transport: normalizeTransport(body.transport),
    },
  }
}

export function parseOAuthCodePayload(payload: unknown): ParseResult<ProviderOAuthCodePayloadContract> {
  const body = toRecord(payload)
  const code = asTrimmedString(body.code)
  if (!code) {
    return { ok: false, error: 'Code is required' }
  }

  return {
    ok: true,
    value: { code },
  }
}

export function parseProviderCreatePayload(
  payload: unknown,
  presets: Record<string, Pick<ProviderTypePresetContract, 'requiresApiKey'>>,
): ParseResult<ProviderCreatePayloadContract> {
  const body = toRecord(payload)
  const name = asTrimmedString(body.name)
  const providerType = asTrimmedString(body.providerType)
  const enabledModels = normalizeEnabledModels(body.enabledModels) ?? []
  const apiKey = asTrimmedString(body.apiKey)

  if (!name) {
    return { ok: false, error: 'Provider name is required' }
  }

  if (!providerType || !isValidProviderType(providerType)) {
    return {
      ok: false,
      error: `Invalid provider type. Must be one of: ${VALID_PROVIDER_TYPES.join(', ')}`,
    }
  }

  const preset = presets[providerType]
  if (preset?.requiresApiKey && !apiKey) {
    return { ok: false, error: 'API key is required for this provider type' }
  }
  const compat = parseCompatField(body)
  if (!compat.ok) return compat

  return {
    ok: true,
    value: {
      name,
      providerType,
      baseUrl: asTrimmedString(body.baseUrl),
      apiKey,
      enabledModels,
      degradedThresholdMs: normalizeDegradedThresholdMs(body.degradedThresholdMs),
      textVerbosity: normalizeTextVerbosity(body.textVerbosity),
      transport: normalizeTransport(body.transport),
      extraFields: normalizeExtraFields(body.extraFields),
      compat: compat.value,
    },
  }
}

export function parseProviderUpdatePayload(payload: unknown): ParseResult<ProviderUpdatePayloadContract> {
  const body = toRecord(payload)
  const providerType = asTrimmedString(body.providerType)
  const disabled = parseOptionalBooleanField(body, 'disabled')
  if (!disabled.ok) return disabled
  const compat = parseCompatField(body)
  if (!compat.ok) return compat

  if (providerType && !isValidProviderType(providerType)) {
    return {
      ok: false,
      error: `Invalid provider type. Must be one of: ${VALID_PROVIDER_TYPES.join(', ')}`,
    }
  }

  return {
    ok: true,
    value: {
      name: asTrimmedString(body.name),
      providerType,
      baseUrl: asTrimmedString(body.baseUrl),
      apiKey: asTrimmedString(body.apiKey),
      enabledModels: normalizeEnabledModels(body.enabledModels),
      enabledImageModels: normalizeEnabledModels(body.enabledImageModels),
      degradedThresholdMs: normalizeDegradedThresholdMs(body.degradedThresholdMs),
      textVerbosity: normalizeTextVerbosity(body.textVerbosity),
      transport: normalizeTransport(body.transport),
      extraFields: normalizeExtraFields(body.extraFields),
      disabled: disabled.value,
      compat: compat.value,
    },
  }
}

export function parseOllamaProbePayload(payload: unknown): ParseResult<{ baseUrl: string; providerType: string }> {
  const body = toRecord(payload)
  const providerType = asTrimmedString(body.providerType)

  if (!providerType || providerType !== 'ollama') {
    return { ok: false, error: 'providerType must be ollama' }
  }

  return {
    ok: true,
    value: {
      providerType,
      baseUrl: asTrimmedString(body.baseUrl) ?? 'http://localhost:11434',
    },
  }
}

export function parseOllamaPullPayload(payload: unknown): ParseResult<{ baseUrl: string; providerType: string; modelName: string }> {
  const body = toRecord(payload)
  const probe = parseOllamaProbePayload(payload)
  const modelName = asTrimmedString(body.modelName)

  if (!probe.ok) return probe

  if (!modelName) {
    return { ok: false, error: 'modelName is required' }
  }

  return {
    ok: true,
    value: {
      ...probe.value,
      modelName,
    },
  }
}

export function parseModelNamePayload(payload: unknown): ParseResult<{ modelName: string }> {
  const body = toRecord(payload)
  const modelName = asTrimmedString(body.modelName)
  if (!modelName) {
    return { ok: false, error: 'modelName is required' }
  }

  return { ok: true, value: { modelName } }
}

export function normalizeOllamaBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, '').replace(/\/$/, '')
}

export function validateOllamaUrl(urlStr: string): void {
  let parsed: URL
  try {
    parsed = new URL(urlStr)
  } catch {
    throw new Error('Invalid Ollama base URL')
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http/https URLs are allowed')
  }
}
