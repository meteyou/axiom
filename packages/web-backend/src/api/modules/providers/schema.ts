import { URL } from 'node:url'
import { PROVIDER_TYPE_PRESETS } from '@axiom/core'
import type {
  ProviderCreatePayloadContract,
  ProviderFallbackUpdatePayloadContract,
  ProviderModelSelectionPayloadContract,
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

export function getValidProviderTypes(): string[] {
  return [...VALID_PROVIDER_TYPES]
}

export function isValidProviderType(providerType: string): boolean {
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
  }
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
  const defaultModel = asTrimmedString(body.defaultModel)

  if (!providerType || !isValidProviderType(providerType)) {
    return { ok: false, error: 'Invalid provider type' }
  }

  if (!name) {
    return { ok: false, error: 'Provider name is required' }
  }

  if (!defaultModel) {
    return { ok: false, error: 'Default model is required' }
  }

  return {
    ok: true,
    value: {
      providerType,
      name,
      defaultModel,
      providerId: asTrimmedString(body.providerId),
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
  const defaultModel = asTrimmedString(body.defaultModel)
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

  if (!defaultModel) {
    return { ok: false, error: 'Default model is required' }
  }

  const preset = presets[providerType]
  if (preset?.requiresApiKey && !apiKey) {
    return { ok: false, error: 'API key is required for this provider type' }
  }

  return {
    ok: true,
    value: {
      name,
      providerType,
      baseUrl: asTrimmedString(body.baseUrl),
      apiKey,
      defaultModel,
      enabledModels: normalizeEnabledModels(body.enabledModels),
      degradedThresholdMs: normalizeDegradedThresholdMs(body.degradedThresholdMs),
    },
  }
}

export function parseProviderUpdatePayload(payload: unknown): ParseResult<ProviderUpdatePayloadContract> {
  const body = toRecord(payload)
  const providerType = asTrimmedString(body.providerType)

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
      defaultModel: asTrimmedString(body.defaultModel),
      enabledModels: normalizeEnabledModels(body.enabledModels),
      degradedThresholdMs: normalizeDegradedThresholdMs(body.degradedThresholdMs),
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
