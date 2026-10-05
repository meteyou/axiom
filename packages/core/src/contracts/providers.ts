import type { ProviderType } from '../provider-config.js'

export type ProviderStatusContract = 'connected' | 'error' | 'untested'

/** Provider families that expose a subscriber usage quota endpoint. */
export type ProviderQuotaKindContract = 'anthropic' | 'openai-codex' | 'opencode-go' | 'zai' | 'radius' | 'openrouter'

/**
 * A single normalized usage window, provider-agnostic. Each window carries its
 * own display hints so the UI can render any provider's quota without knowing
 * the provider's bucket naming.
 */
export interface ProviderQuotaWindowContract {
  /** Stable identifier within the provider (e.g. 'five_hour', 'primary'). */
  key: string
  /** Short display label (e.g. '5h', '7d', 'Opus'). */
  label: string
  /** Integer 0–100 percentage of the window consumed. */
  utilization: number
  /** ISO-8601 timestamp when the window resets, or null if unknown. */
  resetsAt: string | null
  /** Preferred reset rendering: relative countdown or absolute weekday/time. */
  resetDisplay: 'relative' | 'absolute'
}

/**
 * Prepaid credit balance for pay-as-you-go gateways. `available` is what new
 * requests can spend (`total` minus `reserved` holds for in-flight requests).
 */
export interface ProviderQuotaBalanceContract {
  currency: string
  total: number
  reserved: number
  available: number
  /** Amount charged in the current billing period, if the provider reports one. */
  periodSpent?: number | null
  /** ISO-8601 end of the current billing period, if the provider reports one. */
  periodEndsAt?: string | null
}

export interface ProviderQuotaContract {
  kind: ProviderQuotaKindContract
  /** Normalized usage windows in display order (empty for balance-only providers). */
  windows: ProviderQuotaWindowContract[]
  /** Prepaid credit balance (only for credit-based providers such as Radius or OpenRouter). */
  balance?: ProviderQuotaBalanceContract | null
  /** Optional human-readable plan label (e.g. 'Plus', 'Pro', 'Max'). */
  plan?: string | null
  fetchedAt: string
  error?: string
}
export type ProviderAuthMethodContract = 'api-key' | 'oauth'
export type ProviderTextVerbosityContract = 'low' | 'medium' | 'high'
export type ProviderTransportContract = 'sse' | 'websocket' | 'websocket-cached' | 'auto'

export interface ProviderContract {
  id: string
  name: string
  type: string
  providerType: ProviderType | string
  provider: string
  baseUrl: string
  apiKey: string
  apiKeyMasked: string
  enabledModels?: string[]
  /** Image generation models; never part of `enabledModels` or any text-model picker. */
  enabledImageModels?: string[]
  disabled?: boolean
  disabledModels?: string[]
  degradedThresholdMs?: number
  textVerbosity?: ProviderTextVerbosityContract
  transport?: ProviderTransportContract
  status?: ProviderStatusContract
  modelStatuses?: Record<string, ProviderStatusContract>
  authMethod?: ProviderAuthMethodContract
  oauthCredentials?: { expires: number }
  cost?: { input: number; output: number } | null
  modelCosts?: Record<string, { input: number; output: number; cacheRead?: number; cacheWrite?: number }>
  /** Effective runtime specs per enabled model (overrides layered on catalog defaults). */
  modelSpecs?: Record<string, ProviderModelSpecContract>
  /** Catalog details per enabled image model. */
  imageModelSpecs?: Record<string, ImageModelSpecContract>
  /** Per-model user overrides (description, cost, limits). Not masked. */
  models?: ProviderModelContract[]
  /** True when this provider exposes a subscriber usage quota endpoint. */
  supportsQuota?: boolean
  /** Subscriber usage snapshot (only for quota-capable OAuth providers). */
  quota?: ProviderQuotaContract | null
  /** Non-secret provider-specific extra field values (secret values are omitted). */
  extraFields?: Record<string, string>
  /** Presence flags for secret extra fields (the values themselves are never returned). */
  extraFieldsSet?: Record<string, boolean>
  /** pi-ai `compat` options (custom presets only). */
  compat?: Record<string, unknown>
}

/**
 * Per-model user override entry stored in `ProviderConfig.models[]`. Exposed
 * via the API so the UI can edit a model's description and cost.
 */
export interface ProviderModelContract {
  id: string
  name?: string
  description?: string
  contextWindow?: number
  maxTokens?: number
  reasoning?: boolean
  input?: ModelInputModalityContract[]
  /** Output modalities of an image generation model. */
  output?: ModelInputModalityContract[]
  thinkingLevelMap?: ModelThinkingLevelMapContract
  fixedTemperature?: number
  /** Only the fields the user overrode; the rest follows the catalog. */
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
}

export const MODEL_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type ModelThinkingLevelContract = (typeof MODEL_THINKING_LEVELS)[number]
/** pi-ai semantics: a missing key uses the provider default, `null` marks the level as unsupported. */
export type ModelThinkingLevelMapContract = Partial<Record<ModelThinkingLevelContract, string | null>>
export type ModelInputModalityContract = 'text' | 'image'

export interface ProviderModelSpecContract {
  /** Effective display name (user override → catalog → id). */
  name: string
  contextWindow: number
  maxTokens: number
  reasoning: boolean
  input: ModelInputModalityContract[]
  thinkingLevelMap?: ModelThinkingLevelMapContract
}

export interface ImageModelSpecContract {
  /** Effective display name (user override → catalog → id). */
  name: string
  input: ModelInputModalityContract[]
  output: ModelInputModalityContract[]
  pricing?: ImageModelPricingContract
}

/**
 * How image generations are paid for:
 * - `reported`: the provider reports the billed amount
 * - `estimated`: computed from reported tokens and list prices
 * - `subscription`: included in a plan, consumes its usage limits
 */
export type ImageBillingContract = 'reported' | 'estimated' | 'subscription'

/** USD per 1M tokens. */
export interface ImageModelPricingContract {
  textInput: number
  imageInput: number
  imageOutput: number
  textOutput?: number
}

/** Mirrors pi-ai's `getSupportedThinkingLevels`. */
export function getSupportedThinkingLevels(
  spec: Pick<ProviderModelSpecContract, 'reasoning' | 'thinkingLevelMap'>,
): ModelThinkingLevelContract[] {
  if (!spec.reasoning) return ['off']
  return MODEL_THINKING_LEVELS.filter((level) => {
    const mapped = spec.thinkingLevelMap?.[level]
    if (mapped === null) return false
    if (level === 'xhigh' || level === 'max') return mapped !== undefined
    return true
  })
}

/** Mirrors pi-ai's `clampThinkingLevel`: prefer the next higher supported level, then the next lower. */
export function clampThinkingLevel(
  spec: Pick<ProviderModelSpecContract, 'reasoning' | 'thinkingLevelMap'>,
  level: ModelThinkingLevelContract,
): ModelThinkingLevelContract {
  const supported = getSupportedThinkingLevels(spec)
  if (supported.includes(level)) return level
  const index = MODEL_THINKING_LEVELS.indexOf(level)
  const higher = MODEL_THINKING_LEVELS.slice(index + 1).find(candidate => supported.includes(candidate))
  if (higher) return higher
  const lower = MODEL_THINKING_LEVELS.slice(0, index).reverse().find(candidate => supported.includes(candidate))
  return lower ?? supported[0] ?? 'off'
}

/** Declarative definition of one provider-specific extra configuration field. */
export interface ProviderExtraFieldDefContract {
  key: string
  label: string
  secret?: boolean
  required?: boolean
  placeholder?: string
  hint?: string
}

export interface ProviderTypePresetContract {
  type: ProviderType | string
  label: string
  /** Optional human-readable hint shown alongside the label (e.g. for
   *  the generic OpenAI-compatible preset to explain what it covers). */
  description?: string
  apiType: string
  providerName: string
  baseUrl: string
  requiresApiKey: boolean
  urlEditable: boolean
  piAiProvider: string | null
  /**
   * True if the provider type has a known catalog of models (either via
   * pi-ai's registry or via local PROVIDER_TYPE_MODEL_OVERRIDES). The UI
   * uses this to decide whether to render the checkbox list of enabled
   * models instead of a free-text model input.
   */
  hasKnownModels: boolean
  authMethod: ProviderAuthMethodContract
  oauthProviderId?: string
  /**
   * Display-only hint: the UI groups this preset under "Subscription / OAuth"
   * even though it authenticates with an API key (e.g. OpenCode Go).
   */
  subscription?: boolean
  /**
   * True when the Add Model dialog should fetch this provider's model list
   * live from its own `/models` endpoint (via `GET /api/providers/:id/live-models`)
   * instead of the static catalog returned by `hasKnownModels`.
   */
  dynamicCatalog?: boolean
  /** Provider-specific extra fields the UI should render generically. */
  extraFields?: ProviderExtraFieldDefContract[]
  /** True when per-model capability overrides (limits, reasoning, input) take effect at runtime. */
  editableModelSpecs?: boolean
  /** Generic preset for any endpoint speaking `apiType`; accepts pi-ai `compat` options. */
  custom?: boolean
  /** True when the provider can serve image generation models. */
  supportsImageModels?: boolean
  imageBilling?: ImageBillingContract
  /** The Add image model dialog lists the provider's image models live. */
  liveImageCatalog?: boolean
  /** Image model ids outside the list can be added. */
  customImageModels?: boolean
}

export interface AvailableModelContract {
  id: string
  name: string
  contextWindow?: number
  maxTokens?: number
  /** USD per 1M tokens. */
  cost?: { input: number; output: number; cacheRead?: number; cacheWrite?: number }
}

export interface AvailableImageModelContract {
  id: string
  name: string
  input: ModelInputModalityContract[]
  output: ModelInputModalityContract[]
  pricing?: ImageModelPricingContract
}

export interface OllamaModelContract {
  name: string
  size: number
  parameterSize: string
  quantization: string
  family: string
}

export interface OllamaPullEventContract {
  status?: string
  total?: number
  completed?: number
  error?: string
  done?: boolean
}

export interface ProvidersListResponseContract {
  providers: ProviderContract[]
  activeProvider: string | null
  activeModel: string | null
  fallbackProvider: string | null
  fallbackModel: string | null
  presets: Record<string, ProviderTypePresetContract>
}

export interface ProviderMutationResponseContract {
  provider: ProviderContract
}

export interface ProviderQuotaRefreshResponseContract {
  quota: ProviderQuotaContract | null
}

/** Outcome of refreshing the model catalog behind one configured provider. */
export interface ProviderCatalogRefreshResultContract {
  providerId: string
  providerName: string
  status: 'updated' | 'unchanged' | 'error'
  /** Models that became available with this refresh. */
  addedModelIds: string[]
  /** Enabled models the provider's catalog no longer lists (they cannot run reliably). */
  missingModelIds: string[]
  error?: string
}

export interface ProviderCatalogRefreshResponseContract {
  results: ProviderCatalogRefreshResultContract[]
}

export interface ProviderTestResultContract {
  success: boolean
  message?: string
  error?: string
}

/** Result of the paid "Generate test image" action. */
export interface ProviderImageTestResultContract {
  success: boolean
  modelId: string
  error?: string
  /** `data:` URL for the preview; only returned to the admin UI. */
  dataUrl?: string
  mimeType?: string
  /** Cost in USD (billed or estimated, see `billing`), `null` when unknown. */
  costUsd: number | null
  billing?: ImageBillingContract
  durationMs?: number
  /** Parameter adjustments the provider made, e.g. an ignored aspect ratio. */
  notes?: string[]
  /** Usage-limit summary for subscription billing. */
  usageNote?: string
}

export interface ProviderActivationResponseContract {
  activeProvider: string
  activeModel: string | null
}

export interface ProviderFallbackResponseContract {
  fallbackProvider: string | null
  fallbackModel: string | null
}

export interface OAuthLoginResponseContract {
  loginId: string
  authUrl: string
  instructions?: string
  usesCallbackServer: boolean
}

export interface OAuthStatusResponseContract {
  status: 'pending' | 'completed' | 'error'
  provider?: ProviderContract
  error?: string
}

export interface ProviderCreatePayloadContract {
  name: string
  providerType: string
  baseUrl?: string
  apiKey?: string
  enabledModels: string[]
  degradedThresholdMs?: number
  textVerbosity?: ProviderTextVerbosityContract | null
  transport?: ProviderTransportContract | null
  extraFields?: Record<string, string>
  /** Custom presets only: pi-ai `compat` options. */
  compat?: Record<string, unknown> | null
}

export interface ProviderUpdatePayloadContract {
  name?: string
  providerType?: string
  baseUrl?: string
  apiKey?: string
  enabledModels?: string[]
  enabledImageModels?: string[]
  degradedThresholdMs?: number
  textVerbosity?: ProviderTextVerbosityContract | null
  transport?: ProviderTransportContract | null
  extraFields?: Record<string, string>
  disabled?: boolean
  /** Custom presets only; `null` removes all compat options. */
  compat?: Record<string, unknown> | null
}

export interface ProviderFallbackUpdatePayloadContract {
  providerId?: string | null
  modelId?: string | null
}

export interface ProviderOAuthLoginStartPayloadContract {
  providerType: string
  name: string
  enabledModels: string[]
  providerId?: string
  textVerbosity?: ProviderTextVerbosityContract | null
  transport?: ProviderTransportContract | null
}

export interface ProviderOAuthCodePayloadContract {
  code: string
}

export type ProviderModelTypeContract = 'text' | 'image'

export interface ProviderModelSelectionPayloadContract {
  modelId?: string
  /** `image` runs the free image-model availability check instead of a chat request. */
  modelType?: ProviderModelTypeContract
}

/**
 * Body for `PATCH /api/providers/:providerId/models/:modelId`. Only the
 * supplied fields are applied; omitted fields keep their existing (or
 * catalog-default) value.
 */
export interface ProviderModelUpdatePayloadContract {
  disabled?: boolean
  name?: string
  description?: string
  /** For every spec/cost field, `null` removes the override so the value follows the catalog again. */
  contextWindow?: number | null
  maxTokens?: number | null
  reasoning?: boolean | null
  input?: ModelInputModalityContract[] | null
  output?: ModelInputModalityContract[] | null
  thinkingLevelMap?: ModelThinkingLevelMapContract | null
  cost?: {
    input?: number | null
    output?: number | null
    cacheRead?: number | null
    cacheWrite?: number | null
  }
}

export interface ProviderReferenceContract {
  id: string
  enabledModels?: string[]
}

/**
 * Canonicalize provider selectors to "providerId:modelId" while keeping legacy values valid.
 *
 * Compatibility behavior:
 * - "providerId:modelId" stays unchanged
 * - legacy "providerId" expands to "providerId:<first enabled model>" when provider is known
 * - unknown values are returned unchanged
 */
export function canonicalizeProviderModelRef(
  value: string | null | undefined,
  providers: readonly ProviderReferenceContract[],
): string {
  if (!value) return ''

  const trimmed = value.trim()
  if (!trimmed) return ''

  if (trimmed.includes(':')) {
    return trimmed
  }

  const provider = providers.find((candidate) => candidate.id === trimmed)
  if (!provider) return trimmed

  const firstModel = provider.enabledModels?.[0]
  return firstModel ? `${provider.id}:${firstModel}` : trimmed
}

/** Wire APIs with a known pi-ai `compat` schema (the APIs custom presets speak). */
export const COMPAT_API_TYPES = ['openai-completions', 'openai-responses', 'anthropic-messages'] as const
export type CompatApiTypeContract = (typeof COMPAT_API_TYPES)[number]

export function isCompatApiType(value: unknown): value is CompatApiTypeContract {
  return (COMPAT_API_TYPES as readonly unknown[]).includes(value)
}

type CompatFieldKind = 'boolean' | 'number' | 'object' | 'array' | readonly string[]

const SESSION_AFFINITY_FORMATS = ['openai', 'openai-nosession', 'openrouter'] as const

/**
 * pi-ai `compat` options per wire API, mirroring `OpenAICompletionsCompat`,
 * `OpenAIResponsesCompat` and `AnthropicMessagesCompat` from pi-ai 1.0.
 * Update together with the pi-ai dependency.
 */
export const MODEL_COMPAT_FIELDS: Record<CompatApiTypeContract, Record<string, CompatFieldKind>> = {
  'openai-completions': {
    supportsStore: 'boolean',
    supportsDeveloperRole: 'boolean',
    supportsReasoningEffort: 'boolean',
    supportsUsageInStreaming: 'boolean',
    supportsFinishReason: 'boolean',
    maxTokensField: ['max_completion_tokens', 'max_tokens'],
    requiresToolResultName: 'boolean',
    requiresAssistantAfterToolResult: 'boolean',
    requiresThinkingAsText: 'boolean',
    requiresReasoningContentOnAssistantMessages: 'boolean',
    thinkingFormat: ['openai', 'openrouter', 'deepseek', 'together', 'baseten', 'zai', 'qwen', 'chat-template', 'qwen-chat-template', 'string-thinking', 'ant-ling'],
    chatTemplateKwargs: 'object',
    chatTemplateArgs: 'object',
    openRouterRouting: 'object',
    vercelGatewayRouting: 'object',
    zaiToolStream: 'boolean',
    thinkingTokenBudgetField: ['thinking_token_budget', 'thinking_budget', 'thinking_budget_tokens'],
    supportsThinkingTokenBudget: 'boolean',
    supportsOpenAIGrammarTools: 'boolean',
    supportsMidConvoSystemMessages: 'boolean',
    supportsMidConvoToolAdditions: 'boolean',
    supportsStrictMode: 'boolean',
    cacheControlFormat: ['anthropic'],
    sendSessionAffinityHeaders: 'boolean',
    sessionAffinityFormat: SESSION_AFFINITY_FORMATS,
    supportsLongCacheRetention: 'boolean',
    vllmPriority: 'number',
  },
  'openai-responses': {
    supportsDeveloperRole: 'boolean',
    supportsMidConvoSystemMessages: 'boolean',
    sessionAffinityFormat: SESSION_AFFINITY_FORMATS,
    supportsLongCacheRetention: 'boolean',
    supportsStrictMode: 'boolean',
    supportsOpenAIGrammarTools: 'boolean',
    supportsAdditionalTools: 'boolean',
    supportsToolSearch: 'boolean',
    supportsExplicitPromptCacheMode: 'boolean',
    supportsMaxOutputTokens: 'boolean',
  },
  'anthropic-messages': {
    supportsEagerToolInputStreaming: 'boolean',
    supportsLongCacheRetention: 'boolean',
    sendSessionAffinityHeaders: 'boolean',
    sessionAffinityFormat: ['openrouter'],
    supportsCacheControlOnTools: 'boolean',
    supportsTemperature: 'boolean',
    forceAdaptiveThinking: 'boolean',
    allowEmptySignature: 'boolean',
    supportsStrictTools: 'boolean',
    supportsMidConvoEffort: 'boolean',
    supportsMidConvoSystemMessages: 'boolean',
    supportsMidConvoToolChanges: 'boolean',
    allowedFallbackModels: 'array',
  },
}

function compatValueMatches(kind: CompatFieldKind, value: unknown): boolean {
  if (typeof kind !== 'string') return typeof value === 'string' && kind.includes(value)
  if (kind === 'object') return typeof value === 'object' && value !== null && !Array.isArray(value)
  if (kind === 'array') return Array.isArray(value)
  if (kind === 'number') return typeof value === 'number' && Number.isFinite(value)
  return typeof value === kind
}

function describeCompatKind(kind: CompatFieldKind): string {
  return typeof kind === 'string' ? `a ${kind}` : `one of ${kind.map(v => `"${v}"`).join(', ')}`
}

/**
 * Validate a pi-ai `compat` object for the given wire API. Accepts the object
 * itself or a pasted pi provider/model entry that contains a `compat` key.
 */
export function validateModelCompat(
  apiType: CompatApiTypeContract,
  value: unknown,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: 'compat must be a JSON object' }
  }
  const source = value as Record<string, unknown>
  const compat = typeof source.compat === 'object' && source.compat !== null && !Array.isArray(source.compat)
    ? source.compat as Record<string, unknown>
    : source
  const fields = MODEL_COMPAT_FIELDS[apiType]
  for (const [key, entry] of Object.entries(compat)) {
    const kind = fields[key]
    if (!kind) {
      return { ok: false, error: `compat option "${key}" is not supported for ${apiType}. Supported: ${Object.keys(fields).join(', ')}` }
    }
    if (!compatValueMatches(kind, entry)) {
      return { ok: false, error: `compat.${key} must be ${describeCompatKind(kind)}` }
    }
  }
  return { ok: true, value: { ...compat } }
}
