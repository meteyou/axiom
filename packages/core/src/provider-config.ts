import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { Api, ImageApi, ImageModel, Model, Transport } from '@earendil-works/pi-ai'
import { getPiCatalogModels } from './pi-catalog.js'
import { getImageCatalogModels, toAvailableImageModel } from './image-catalog.js'
import type { AvailableImageModel } from './image-catalog.js'
import { getOAuthApiKey } from './pi-oauth.js'
import type { OAuthCredentials } from '@earendil-works/pi-ai/oauth'
import { streamSimple } from './pi-models.js'
import { getConfigDir, ensureConfigTemplates, loadConfig } from './config.js'
import { encrypt, decrypt, isEncrypted, maskApiKey } from './encryption.js'
import { RADIUS_BASE_URL, findRadiusCatalogModel, radiusCatalogToAvailableModels } from './radius-catalog.js'
import { validateModelCompat } from './contracts/providers.js'
import type { CompatApiTypeContract } from './contracts/providers.js'
import type { ModelCompactionOverrideContract, ModelInputModalityContract, ModelThinkingLevelMapContract, ProviderModelTypeContract, ProviderModelUpdatePayloadContract } from './contracts/providers.js'

/**
 * Claude Code CLI version to advertise in the user-agent header for Anthropic requests.
 * This ensures Anthropic treats requests as coming from a Claude Code client.
 * Model headers override pi-ai's own OAuth user-agent, so keep this in sync with
 * `claudeCodeVersion` in `@earendil-works/pi-ai/dist/api/anthropic-messages.js`.
 */
export const CLAUDE_CODE_VERSION = '2.1.287'

/**
 * Supported provider types with presets
 */
export type ProviderType =
  | 'openai' | 'anthropic' | 'mistral' | 'ollama' | 'openrouter' | 'deepseek' | 'kimi' | 'minimax' | 'zai' | 'zai-coding' | 'xai' | 'opencode-go' | 'opencode-zen' | CustomProviderType | 'google'
  | 'radius' | 'radius-api-key'
  // Legacy aliases kept for migration
  | 'ollama-local' | 'ollama-cloud'
  | 'openai-codex' | 'github-copilot' | 'anthropic-oauth'

export type AuthMethod = 'api-key' | 'oauth'
export type TextVerbosity = 'low' | 'medium' | 'high'
export type ProviderTransport = Transport

export interface ProviderTypePreset {
  type: ProviderType
  label: string
  description?: string
  apiType: string // pi-ai API type (used for api-key providers)
  providerName: string
  baseUrl: string
  requiresApiKey: boolean
  urlEditable: boolean
  piAiProvider: string | null // maps to pi-ai KnownProvider for model lookup
  authMethod: AuthMethod
  oauthProviderId?: string // pi-ai OAuth provider ID
  /**
   * Provider-specific extra configuration fields beyond the common ones
   * (name/apiKey/baseUrl/models). Declared per preset so new providers can
   * add bespoke inputs (e.g. OpenCode Go's quota-dashboard credentials)
   * without growing `ProviderConfig` with provider-specific properties. The
   * values are stored in `ProviderConfig.extraFields`; fields marked `secret`
   * are encrypted at rest and never returned to the client.
   */
  extraFields?: ProviderExtraFieldDef[]
  /**
   * When true, `buildModel()` returns the pi-ai catalog model verbatim
   * (per-model `api`, `baseUrl`, cost, limits) instead of the generic build
   * that pins every model to the preset's single `apiType`. Required for
   * gateways like OpenCode Zen/Go whose models span multiple wire APIs
   * (openai-completions, anthropic-messages, google, responses) under one
   * provider entry.
   */
  resolveModelsFromCatalog?: boolean
  /**
   * Generic preset for any endpoint speaking `apiType`: no catalog, editable
   * URL, models listed live, and pi-ai `compat` options per provider.
   */
  custom?: boolean
  /**
   * Display-only hint: group this preset under "Subscription / OAuth" in the
   * UI even though it authenticates with an API key (e.g. OpenCode Go is a
   * flat-fee subscription that issues an API key rather than using OAuth).
   * Does not affect the auth flow — `authMethod` still drives that.
   */
  subscription?: boolean
  /**
   * When true, the Add Model dialog lists models fetched live from the
   * provider's own `/models` endpoint (using the stored baseUrl + apiKey)
   * instead of the static pi-ai catalog. The live list replaces the curated
   * one; the curated `getAvailableModels()` result is only used as an offline
   * fallback when the live fetch fails. Suitable for gateways whose catalog
   * changes frequently and is authoritative at the source (e.g. OpenRouter).
   */
  dynamicCatalog?: boolean
}

export interface AvailableModel {
  id: string
  name: string
  contextWindow?: number
  maxTokens?: number
  /** USD per 1M tokens. */
  cost?: { input: number; output: number; cacheRead?: number; cacheWrite?: number }
}

/**
 * Declarative definition of one provider-specific extra configuration field.
 * Rendered generically by the UI and persisted into `ProviderConfig.extraFields`.
 */
export interface ProviderExtraFieldDef {
  /** Stable key within the provider type (also the storage key). */
  key: string
  /** Default English label (UIs may localize via an i18n override). */
  label: string
  /** Encrypt at rest and never return the value to the client. */
  secret?: boolean
  required?: boolean
  placeholder?: string
  hint?: string
}

export type CustomProviderType = `custom-${CompatApiTypeContract}`

function customPreset(type: CustomProviderType, apiType: CompatApiTypeContract, label: string): ProviderTypePreset {
  return {
    type,
    label,
    apiType,
    providerName: 'custom',
    baseUrl: '',
    requiresApiKey: false,
    urlEditable: true,
    piAiProvider: null,
    authMethod: 'api-key',
    dynamicCatalog: true,
    custom: true,
  }
}

export const PROVIDER_TYPE_PRESETS: Record<ProviderType, ProviderTypePreset> = {
  // ── API Key providers ──
  openai: {
    type: 'openai',
    label: 'OpenAI',
    apiType: 'openai-completions',
    providerName: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    requiresApiKey: true,
    urlEditable: false,
    piAiProvider: 'openai',
    authMethod: 'api-key',
  },
  anthropic: {
    type: 'anthropic',
    label: 'Anthropic',
    apiType: 'anthropic-messages',
    providerName: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    requiresApiKey: true,
    urlEditable: false,
    piAiProvider: 'anthropic',
    authMethod: 'api-key',
  },
  mistral: {
    type: 'mistral',
    label: 'Mistral',
    apiType: 'mistral-conversations',
    providerName: 'mistral',
    baseUrl: 'https://api.mistral.ai',
    requiresApiKey: true,
    urlEditable: false,
    piAiProvider: 'mistral',
    authMethod: 'api-key',
  },
  'ollama': {
    type: 'ollama',
    label: 'Ollama',
    apiType: 'openai-completions',
    providerName: 'ollama',
    baseUrl: 'http://localhost:11434/v1',
    requiresApiKey: false,
    urlEditable: true,
    piAiProvider: null,
    authMethod: 'api-key',
  },
  // Legacy aliases — map to 'ollama' so existing configs still load
  'ollama-local': {
    type: 'ollama',
    label: 'Ollama',
    apiType: 'openai-completions',
    providerName: 'ollama',
    baseUrl: 'http://localhost:11434/v1',
    requiresApiKey: false,
    urlEditable: true,
    piAiProvider: null,
    authMethod: 'api-key',
  },
  'ollama-cloud': {
    type: 'ollama',
    label: 'Ollama',
    apiType: 'openai-completions',
    providerName: 'ollama',
    baseUrl: 'http://localhost:11434/v1',
    requiresApiKey: false,
    urlEditable: true,
    piAiProvider: null,
    authMethod: 'api-key',
  },
  openrouter: {
    type: 'openrouter',
    label: 'OpenRouter',
    apiType: 'openai-completions',
    providerName: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    requiresApiKey: true,
    urlEditable: false,
    piAiProvider: 'openrouter',
    authMethod: 'api-key',
    dynamicCatalog: true,
  },
  deepseek: {
    type: 'deepseek',
    label: 'DeepSeek',
    apiType: 'openai-completions',
    providerName: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    requiresApiKey: true,
    urlEditable: false,
    piAiProvider: 'deepseek',
    authMethod: 'api-key',
  },
  kimi: {
    type: 'kimi',
    label: 'Kimi / Moonshot',
    apiType: 'openai-completions',
    providerName: 'moonshot',
    baseUrl: 'https://api.moonshot.ai/v1',
    requiresApiKey: true,
    urlEditable: false,
    piAiProvider: null,
    authMethod: 'api-key',
  },
  minimax: {
    type: 'minimax',
    label: 'MiniMax',
    apiType: 'anthropic-messages',
    providerName: 'minimax',
    baseUrl: 'https://api.minimax.io/anthropic',
    requiresApiKey: true,
    urlEditable: false,
    piAiProvider: 'minimax',
    authMethod: 'api-key',
  },
  zai: {
    type: 'zai',
    label: 'z.ai',
    apiType: 'openai-completions',
    providerName: 'zai',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    requiresApiKey: true,
    urlEditable: false,
    piAiProvider: 'zai',
    authMethod: 'api-key',
  },
  'zai-coding': {
    type: 'zai-coding',
    label: 'z.ai (GLM Coding Plan)',
    description: 'z.ai GLM Coding Plan subscription (flat-fee, API-key based)',
    apiType: 'openai-completions',
    providerName: 'zai',
    baseUrl: 'https://api.z.ai/api/coding/paas/v4',
    requiresApiKey: true,
    urlEditable: false,
    piAiProvider: 'zai',
    authMethod: 'api-key',
    subscription: true,
  },
  xai: {
    type: 'xai',
    label: 'xAI (Grok)',
    apiType: 'openai-completions',
    providerName: 'xai',
    baseUrl: 'https://api.x.ai/v1',
    requiresApiKey: true,
    urlEditable: false,
    piAiProvider: 'xai',
    authMethod: 'api-key',
  },
  'opencode-go': {
    type: 'opencode-go',
    label: 'OpenCode Go',
    apiType: 'openai-completions',
    providerName: 'opencode-go',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    requiresApiKey: true,
    urlEditable: false,
    piAiProvider: 'opencode-go',
    authMethod: 'api-key',
    resolveModelsFromCatalog: true,
    subscription: true,
    extraFields: [
      {
        key: 'workspaceId',
        label: 'Workspace ID',
        placeholder: 'e.g. 0a1b2c3d',
        hint: 'From your dashboard URL: opencode.ai/workspace/[id]/go',
      },
      {
        key: 'authCookie',
        label: 'Dashboard Auth Cookie',
        secret: true,
        hint: 'The authenticated dashboard cookie (the `auth=` prefix is optional). Used only to read your usage quota.',
      },
    ],
  },
  'opencode-zen': {
    type: 'opencode-zen',
    label: 'OpenCode Zen',
    description: 'Pay-as-you-go AI gateway by the OpenCode team',
    apiType: 'openai-completions',
    providerName: 'opencode',
    baseUrl: 'https://opencode.ai/zen/v1',
    requiresApiKey: true,
    urlEditable: false,
    piAiProvider: 'opencode',
    authMethod: 'api-key',
    resolveModelsFromCatalog: true,
  },
  'custom-openai-completions': customPreset('custom-openai-completions', 'openai-completions', 'Custom – OpenAI Chat Completions'),
  'custom-openai-responses': customPreset('custom-openai-responses', 'openai-responses', 'Custom – OpenAI Responses'),
  'custom-anthropic-messages': customPreset('custom-anthropic-messages', 'anthropic-messages', 'Custom – Anthropic Messages'),

  google: {
    type: 'google',
    label: 'Google Gemini',
    apiType: 'google-generative-ai',
    providerName: 'google',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    requiresApiKey: true,
    urlEditable: false,
    piAiProvider: 'google',
    authMethod: 'api-key',
  },
  'radius-api-key': {
    type: 'radius-api-key',
    label: 'Radius (API key)',
    description: 'Pi-native gateway by Earendil, authenticated with an organization API key',
    apiType: 'pi-messages',
    providerName: 'radius',
    baseUrl: RADIUS_BASE_URL,
    requiresApiKey: true,
    urlEditable: false,
    piAiProvider: null,
    authMethod: 'api-key',
    dynamicCatalog: true,
  },

  // ── OAuth / Subscription providers ──
  'openai-codex': {
    type: 'openai-codex',
    label: 'ChatGPT Plus/Pro (Codex)',
    apiType: 'openai-codex-responses',
    providerName: 'openai-codex',
    baseUrl: '',
    requiresApiKey: false,
    urlEditable: false,
    piAiProvider: 'openai-codex',
    authMethod: 'oauth',
    oauthProviderId: 'openai-codex',
  },
  'github-copilot': {
    type: 'github-copilot',
    label: 'GitHub Copilot',
    apiType: 'openai-completions',
    providerName: 'github-copilot',
    baseUrl: '',
    requiresApiKey: false,
    urlEditable: false,
    piAiProvider: 'github-copilot',
    authMethod: 'oauth',
    oauthProviderId: 'github-copilot',
  },
  'anthropic-oauth': {
    type: 'anthropic-oauth',
    label: 'Anthropic (Claude Pro/Max)',
    apiType: 'anthropic-messages',
    providerName: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    requiresApiKey: false,
    urlEditable: false,
    piAiProvider: 'anthropic',
    authMethod: 'oauth',
    oauthProviderId: 'anthropic',
  },
  radius: {
    type: 'radius',
    label: 'Radius',
    description: 'Pi-native gateway by Earendil (credits, routing, rewrites) — sign in with your Radius account',
    apiType: 'pi-messages',
    providerName: 'radius',
    baseUrl: RADIUS_BASE_URL,
    requiresApiKey: false,
    urlEditable: false,
    piAiProvider: null,
    authMethod: 'oauth',
    oauthProviderId: 'radius',
    dynamicCatalog: true,
  },
}

/**
 * Whether a provider type talks to the Radius gateway (either auth method).
 * Radius has no static pi-ai catalog; its models come from `radius-catalog.ts`.
 */
export function isRadiusProviderType(providerType: ProviderType | string): boolean {
  return PROVIDER_TYPE_PRESETS[providerType as ProviderType]?.providerName === 'radius'
}

/**
 * Local catalog overrides for provider types whose model list is not well
 * represented in pi-ai. Entries here take precedence over pi-ai and also feed
 * buildModel() with metadata (contextWindow, maxTokens, cost, reasoning) so
 * the UI and cost estimation work without requiring users to configure each
 * model manually.
 *
 * Keep this list in sync with the upstream provider's published catalog.
 */
export const PROVIDER_TYPE_MODEL_OVERRIDES: Partial<Record<ProviderType, ProviderModelConfig[]>> = {
  // Moonshot Platform API (https://platform.moonshot.ai)
  // Confirmed current 2026-06-30 via official pricing docs + cross-provider
  // listings (OpenRouter, TokenMix, getmaxim.ai). Pricing in USD per 1M tokens.
  kimi: [
    // Current K2 family
    // Note: K2 reasoning models only accept `temperature: 1` (the upstream API
    // returns "invalid temperature: only 1 is allowed for this model" otherwise).
    { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code', contextWindow: 262_144, maxTokens: 262_144, reasoning: true, fixedTemperature: 1,
      cost: { input: 0.95, output: 4.0, cacheRead: 0.19, cacheWrite: 0 } },
    { id: 'kimi-k2.7-code-highspeed', name: 'Kimi K2.7 Code HighSpeed', contextWindow: 262_144, maxTokens: 262_144, reasoning: true, fixedTemperature: 1,
      cost: { input: 1.9, output: 8.0, cacheRead: 0.38, cacheWrite: 0 } },
    { id: 'kimi-k2.6', name: 'Kimi K2.6', contextWindow: 262_144, maxTokens: 262_144, reasoning: true, fixedTemperature: 1,
      cost: { input: 0.95, output: 4.0, cacheRead: 0.16, cacheWrite: 0 } },
    { id: 'kimi-k2.5', name: 'Kimi K2.5', contextWindow: 262_144, maxTokens: 262_144, reasoning: true, fixedTemperature: 1,
      cost: { input: 0.6, output: 3.0, cacheRead: 0.1, cacheWrite: 0 } },
    { id: 'kimi-k2-thinking', name: 'Kimi K2 Thinking', contextWindow: 262_144, maxTokens: 262_144, reasoning: true, fixedTemperature: 1,
      cost: { input: 0.6, output: 2.5, cacheRead: 0.15, cacheWrite: 0 } },
    { id: 'kimi-k2-thinking-turbo', name: 'Kimi K2 Thinking Turbo', contextWindow: 262_144, maxTokens: 262_144, reasoning: true, fixedTemperature: 1,
      cost: { input: 1.15, output: 8.0, cacheRead: 0.15, cacheWrite: 0 } },
    { id: 'kimi-k2-turbo-preview', name: 'Kimi K2 Turbo (preview)', contextWindow: 262_144, maxTokens: 262_144, reasoning: false,
      cost: { input: 2.4, output: 10.0, cacheRead: 0.6, cacheWrite: 0 } },
    { id: 'kimi-k2-0905-preview', name: 'Kimi K2 0905 (preview)', contextWindow: 262_144, maxTokens: 262_144, reasoning: false,
      cost: { input: 0.6, output: 2.5, cacheRead: 0.15, cacheWrite: 0 } },
    { id: 'kimi-k2-0711-preview', name: 'Kimi K2 0711 (preview)', contextWindow: 131_072, maxTokens: 16_384, reasoning: false,
      cost: { input: 0.6, output: 2.5, cacheRead: 0.15, cacheWrite: 0 } },

    // Convenience alias that always points at the latest stable
    { id: 'kimi-latest', name: 'Kimi Latest', contextWindow: 131_072, maxTokens: 32_768, reasoning: false,
      cost: { input: 0.6, output: 2.5, cacheRead: 0.15, cacheWrite: 0 } },

    // Legacy moonshot-v1 line (still available on the platform)
    { id: 'moonshot-v1-auto', name: 'Moonshot v1 Auto', contextWindow: 131_072, maxTokens: 8_192, reasoning: false,
      cost: { input: 2.0, output: 5.0 } },
    { id: 'moonshot-v1-8k', name: 'Moonshot v1 8K', contextWindow: 8_192, maxTokens: 8_192, reasoning: false,
      cost: { input: 0.2, output: 1.0 } },
    { id: 'moonshot-v1-32k', name: 'Moonshot v1 32K', contextWindow: 32_768, maxTokens: 8_192, reasoning: false,
      cost: { input: 0.5, output: 1.5 } },
    { id: 'moonshot-v1-128k', name: 'Moonshot v1 128K', contextWindow: 131_072, maxTokens: 8_192, reasoning: false,
      cost: { input: 2.0, output: 5.0 } },
    { id: 'moonshot-v1-8k-vision-preview', name: 'Moonshot v1 8K Vision (preview)', contextWindow: 8_192, maxTokens: 8_192, reasoning: false,
      cost: { input: 0.2, output: 1.0 } },
    { id: 'moonshot-v1-32k-vision-preview', name: 'Moonshot v1 32K Vision (preview)', contextWindow: 32_768, maxTokens: 8_192, reasoning: false,
      cost: { input: 0.5, output: 1.5 } },
    { id: 'moonshot-v1-128k-vision-preview', name: 'Moonshot v1 128K Vision (preview)', contextWindow: 131_072, maxTokens: 8_192, reasoning: false,
      cost: { input: 2.0, output: 5.0 } },
  ],
}

/**
 * Whether a provider type's pi-ai apiType actually consumes the
 * `textVerbosity` stream option. Today only the OpenAI Codex / Responses
 * API honours it; for every other provider the value is silently ignored
 * downstream, so we drop it on persist instead of storing a no-op.
 */
export function presetSupportsTextVerbosity(providerType: ProviderType): boolean {
  const preset = PROVIDER_TYPE_PRESETS[providerType]
  return preset?.apiType === 'openai-codex-responses'
}

/**
 * Whether a provider type's pi-ai apiType actually consumes the `transport`
 * stream option. Today only the OpenAI Codex / Responses API supports the
 * WebSocket / cached-WebSocket transports; every other provider streams over
 * SSE only and the value is silently ignored. We drop the field on persist
 * for unsupported providers so it cannot accidentally diverge from runtime
 * behaviour.
 */
export function presetSupportsTransport(providerType: ProviderType): boolean {
  const preset = PROVIDER_TYPE_PRESETS[providerType]
  return preset?.apiType === 'openai-codex-responses'
}

/**
 * Pure helper: merge the configured `textVerbosity` into a `streamSimple`
 * options object. Returns `opts` unchanged when the provider has no
 * verbosity override. Exported so tests can lock the contract without
 * having to mock pi-ai's streamSimple.
 */
export function applyTextVerbosity<T extends object | undefined>(
  textVerbosity: TextVerbosity | undefined,
  opts: T,
): T {
  if (!textVerbosity) return opts
  return { ...(opts ?? {}), textVerbosity } as T
}

/**
 * Pure helper: merge the configured `transport` into a `streamSimple` options
 * object. Returns `opts` unchanged when the provider has no transport
 * override or when the override is the default `"sse"`. Exported so tests can
 * lock the contract without having to mock pi-ai's streamSimple.
 *
 * The default of `"sse"` is a no-op upstream (pi-ai also defaults to SSE), so
 * we omit it from the spread to keep call paths identity-preserving when no
 * change is requested.
 */
export function applyTransport<T extends object | undefined>(
  transport: ProviderTransport | undefined,
  opts: T,
): T {
  if (!transport || transport === 'sse') return opts
  return { ...(opts ?? {}), transport } as T
}

/**
 * Build the `streamFn` callback that the agent loop hands to pi-agent-core.
 * Wraps `streamSimple` and forwards the provider's `textVerbosity` and
 * `transport` overrides when configured. Centralising this keeps the cast
 * in one place and makes it impossible to forget the spread at a call site.
 *
 * pi-agent-core also reads `transport` directly from its `Agent` constructor
 * options and forwards it on every loop turn, so a configured non-`sse`
 * transport flows through both code paths.
 *
 * The `streamSimple` argument is injectable purely for testing; production
 * call sites should omit it so the real pi-ai implementation is used.
 */
export function buildStreamFn(
  provider: Pick<ProviderConfig, 'textVerbosity' | 'transport'>,
  streamImpl: typeof streamSimple = streamSimple,
): typeof streamSimple {
  return ((model, context, options) => {
    const withVerbosity = applyTextVerbosity(provider.textVerbosity, options)
    const merged = applyTransport(provider.transport, withVerbosity) as Parameters<typeof streamSimple>[2]
    return streamImpl(model, context, merged)
  }) as typeof streamSimple
}

/**
 * Whether a provider type serves its Add Model catalog live from the
 * provider's own `/models` endpoint instead of the static pi-ai catalog.
 */
export function isDynamicCatalogProvider(providerType: ProviderType | string): boolean {
  return Boolean(PROVIDER_TYPE_PRESETS[providerType as ProviderType]?.dynamicCatalog)
}

function getImageCatalogForType(providerType: ProviderType | string): ImageModel<ImageApi>[] {
  return getImageCatalogModels(PROVIDER_TYPE_PRESETS[providerType as ProviderType]?.piAiProvider, providerType)
}

/** Whether the provider type can serve image generation models (an image catalog exists for it). */
export function supportsImageModels(providerType: ProviderType | string): boolean {
  return getImageCatalogForType(providerType).length > 0
}

/** Image generation models selectable for a provider type (image catalog, not the text catalog). */
export function getAvailableImageModels(providerType: ProviderType | string): AvailableImageModel[] {
  return getImageCatalogForType(providerType).map(toAvailableImageModel)
}

/** The image API a provider type's image models are served on. */
export function getImageApiForType(providerType: ProviderType | string): ImageApi | undefined {
  return getImageCatalogForType(providerType)[0]?.api
}

/** Base URL image requests of a provider go to. */
export function getImageBaseUrl(provider: Pick<ProviderConfig, 'providerType' | 'baseUrl'>): string | undefined {
  return provider.baseUrl || getImageCatalogForType(provider.providerType)[0]?.baseUrl
}

/**
 * Ids pi-ai lists as image models that produce no text and are not chat
 * models for this provider type. Such ids cannot serve chat turns, so they
 * belong in `enabledImageModels`, never in `enabledModels`. Image models that
 * also answer with text (e.g. Gemini image models) stay usable for chat.
 */
export function createImageOnlyModelIdMatcher(providerType: ProviderType | string): (modelId: string) => boolean {
  const imageIds = new Set(getImageCatalogForType(providerType).filter(m => !m.output.includes('text')).map(m => m.id))
  if (imageIds.size === 0) return () => false
  const piAiProvider = PROVIDER_TYPE_PRESETS[providerType as ProviderType]?.piAiProvider
  // Built on first use: providers.json loads run this for every provider, and most ids are no image models.
  let textIds: Set<string> | undefined
  return (modelId) => {
    if (!imageIds.has(modelId)) return false
    textIds ??= new Set(piAiProvider ? getPiCatalogModels(piAiProvider).map(m => m.id) : [])
    return !textIds.has(modelId)
  }
}

/**
 * Whether per-model spec overrides (limits, reasoning, input, thinking map)
 * reach the runtime model. Catalog-resolved and Radius models are built from
 * their upstream catalog in `buildModel()` and ignore these overrides.
 */
export function supportsModelSpecOverrides(providerType: ProviderType | string): boolean {
  const preset = PROVIDER_TYPE_PRESETS[providerType as ProviderType]
  if (!preset || isRadiusProviderType(providerType)) return false
  return !(preset.piAiProvider && (preset.authMethod === 'oauth' || preset.resolveModelsFromCatalog))
}

/**
 * Get available models for a given provider type: pi-ai's generated catalog
 * for the preset's piAiProvider, with PROVIDER_TYPE_MODEL_OVERRIDES entries
 * layered on top (added, or replacing a catalog entry of the same id).
 */
export function getAvailableModels(providerType: ProviderType): AvailableModel[] {
  if (isRadiusProviderType(providerType)) return radiusCatalogToAvailableModels()

  const preset = PROVIDER_TYPE_PRESETS[providerType]
  const catalogModels: AvailableModel[] = preset?.piAiProvider
    ? getPiCatalogModels(preset.piAiProvider).map(m => toAvailableModel(m))
    : []

  const overrides = PROVIDER_TYPE_MODEL_OVERRIDES[providerType] ?? []
  const merged = new Map(catalogModels.map(m => [m.id, m]))
  for (const override of overrides) {
    merged.set(override.id, toAvailableModel({ ...override, name: override.name ?? override.id }))
  }
  return Array.from(merged.values())
}

function toAvailableModel(model: {
  id: string
  name: string
  contextWindow?: number
  maxTokens?: number
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
}): AvailableModel {
  const { cost } = model
  return {
    id: model.id,
    name: model.name,
    ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
    ...(model.maxTokens ? { maxTokens: model.maxTokens } : {}),
    ...(cost?.input !== undefined && cost.output !== undefined
      ? {
          cost: {
            input: cost.input,
            output: cost.output,
            ...(cost.cacheRead ? { cacheRead: cost.cacheRead } : {}),
            ...(cost.cacheWrite ? { cacheWrite: cost.cacheWrite } : {}),
          },
        }
      : {}),
  }
}

/**
 * Look up an override model config by provider type and model id, if any.
 */
function findOverrideModel(providerType: ProviderType | undefined, modelId: string): ProviderModelConfig | undefined {
  if (!providerType) return undefined
  const overrides = PROVIDER_TYPE_MODEL_OVERRIDES[providerType]
  return overrides?.find(m => m.id === modelId)
}

function findPiAiCatalogModel(providerType: ProviderType | undefined, modelId: string): Model<Api> | undefined {
  if (!providerType) return undefined
  const preset = PROVIDER_TYPE_PRESETS[providerType]
  if (!preset?.piAiProvider) return undefined
  return getPiCatalogModels(preset.piAiProvider).find(m => m.id === modelId)
}

/**
 * Effective per-model overrides: the user's `provider.models[]` entry layered
 * field by field over the local `PROVIDER_TYPE_MODEL_OVERRIDES` entry. Entries
 * only hold what the user changed, so everything else keeps following the
 * catalog (including catalog refreshes).
 */
function resolveModelConfig(provider: Pick<ProviderConfig, 'providerType' | 'models'>, modelId: string): ProviderModelConfig | undefined {
  const entry = provider.models?.find(m => m.id === modelId)
  const override = findOverrideModel(provider.providerType, modelId)
  if (!entry) return override
  if (!override) return entry
  const defined = <T extends object>(value: T | undefined): Partial<T> =>
    Object.fromEntries(Object.entries(value ?? {}).filter(([, v]) => v !== undefined)) as Partial<T>
  const cost = { ...defined(override.cost), ...defined(entry.cost) }
  return {
    ...override,
    ...defined(entry),
    ...(Object.keys(cost).length > 0 ? { cost } : {}),
  }
}

function catalogModelRequiresTemperatureOne(providerType: ProviderType | undefined, modelId: string): boolean {
  const catalogModel = findPiAiCatalogModel(providerType, modelId)
  return Boolean(catalogModel?.reasoning && /^kimi-k2(?:[.-]|$)/.test(catalogModel.id))
}

/**
 * Resolve the effective sampling temperature for a given provider+model.
 *
 * Some upstream APIs reject any temperature other than a specific value (for
 * example, Moonshot's Kimi K2 thinking models only accept `temperature: 1`).
 * Callers should route their desired temperature through this helper so such
 * constraints are honored without scattering model-specific knowledge across
 * the codebase.
 *
 * Resolution order for the constraint:
 *   1. `provider.models[].fixedTemperature` (per-provider user override)
 *   2. `PROVIDER_TYPE_MODEL_OVERRIDES[...].fixedTemperature` (local catalog)
 *   3. pi-ai catalog metadata for known Kimi K2 reasoning models
 *
 * If no constraint applies, the `requested` value is returned unchanged.
 */
export function resolveModelTemperature(
  provider: Pick<ProviderConfig, 'providerType' | 'models'>,
  modelId: string,
  requested: number,
): number {
  const configured = provider.models?.find(m => m.id === modelId)
  if (configured?.fixedTemperature !== undefined) {
    return configured.fixedTemperature
  }
  const override = findOverrideModel(provider.providerType, modelId)
  if (override?.fixedTemperature !== undefined) {
    return override.fixedTemperature
  }
  if (catalogModelRequiresTemperatureOne(provider.providerType, modelId)) {
    return 1
  }
  return requested
}

/**
 * Provider configuration as stored in providers.json
 */
export interface ProviderConfig {
  id: string
  name: string
  type: string // e.g., 'openai-completions', 'anthropic-messages'
  providerType: ProviderType // e.g., 'openai', 'anthropic', 'ollama'
  provider: string // e.g., 'openai', 'anthropic', 'xai'
  baseUrl: string
  apiKey: string // encrypted at rest
  enabledModels?: string[] // list of model IDs enabled for this provider; first entry is the default/primary model
  /**
   * Image generation models enabled for this provider. Kept apart from
   * `enabledModels` so image models never reach chat/task model pickers, the
   * active/fallback selection or the text-model routing list.
   */
  enabledImageModels?: string[]
  /**
   * Hides the provider from every LLM model picker and from the agent. Its
   * credentials stay usable for TTS/STT.
   */
  disabled?: boolean
  /** Subset of `enabledModels` hidden from model pickers and the agent. */
  disabledModels?: string[]
  /** Subset of `enabledImageModels` hidden from the agent and the default-image-model picker. */
  disabledImageModels?: string[]
  degradedThresholdMs?: number
  textVerbosity?: TextVerbosity
  transport?: ProviderTransport
  models?: ProviderModelConfig[]
  status?: 'connected' | 'error' | 'untested'
  modelStatuses?: Record<string, 'connected' | 'error' | 'untested'>
  authMethod?: AuthMethod
  oauthCredentials?: OAuthCredentialsStored // encrypted at rest
  /**
   * pi-ai `compat` options passed to every model of this provider. Only
   * custom presets set this.
   */
  compat?: Record<string, unknown>
  /**
   * Provider-specific extra field values (see `ProviderTypePreset.extraFields`).
   * Values for fields declared `secret` are encrypted at rest.
   */
  extraFields?: Record<string, string>
}

/**
 * OAuth credentials as stored in providers.json (encrypted)
 */
export interface OAuthCredentialsStored {
  refresh: string // encrypted
  access: string // encrypted
  expires: number
  extra?: string // encrypted JSON of additional fields
}

export interface ProviderModelConfig {
  id: string
  name?: string
  /**
   * Free-form note describing what this model is suited for. Surfaced in the
   * system prompt's `<available_providers>` block so the agent can route
   * background tasks to it. A model without a description (and that is not
   * the active/task default) is hidden from the agent's routing list.
   */
  description?: string
  contextWindow?: number
  maxTokens?: number
  reasoning?: boolean
  input?: ModelInputModalityContract[]
  /** Output modalities of an image generation model; text models ignore it. */
  output?: ModelInputModalityContract[]
  thinkingLevelMap?: ModelThinkingLevelMapContract
  /**
   * If set, the upstream API only accepts this exact `temperature` value and
   * rejects any other value (e.g. Moonshot's Kimi K2 thinking models require
   * `temperature: 1`). Callers should pass the requested value through
   * `resolveModelTemperature()` so this constraint is honored.
   */
  fixedTemperature?: number
  /** USD per 1M tokens; unset fields fall back to the catalog. */
  cost?: {
    input?: number
    output?: number
    cacheRead?: number
    cacheWrite?: number
  }
  compaction?: ModelCompactionOverrideContract
}

export interface ProvidersFile {
  providers: ProviderConfig[]
  activeProvider?: string
  activeModel?: string // model ID within the active provider
  fallbackProvider?: string
  fallbackModel?: string // model ID within the fallback provider
  _comment?: string
}

/**
 * Price table for common models (cost per million tokens in USD)
 * Used as fallback when pi-mono cost data is not available
 */
export type TokenPriceTable = Record<string, { input: number; output: number }>

export const DEFAULT_PRICE_TABLE: TokenPriceTable = {
  'gpt-4o': { input: 2.50, output: 10.00 },
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'gpt-4-turbo': { input: 10.00, output: 30.00 },
  'gpt-3.5-turbo': { input: 0.50, output: 1.50 },
  'claude-sonnet-4-20250514': { input: 3.00, output: 15.00 },
  'claude-3-5-sonnet-20241022': { input: 3.00, output: 15.00 },
  'claude-3-opus-20240229': { input: 15.00, output: 75.00 },
  'claude-3-haiku-20240307': { input: 0.25, output: 1.25 },
}

/**
 * Extra-field definitions declared by a provider type's preset (empty when none).
 */
export function getProviderExtraFieldDefs(providerType: ProviderType | string): ProviderExtraFieldDef[] {
  return PROVIDER_TYPE_PRESETS[providerType as ProviderType]?.extraFields ?? []
}

function secretExtraFieldKeys(providerType: ProviderType | string): Set<string> {
  return new Set(getProviderExtraFieldDefs(providerType).filter(f => f.secret).map(f => f.key))
}

/**
 * Decrypt the secret entries of a stored `extraFields` record, leaving
 * non-secret values untouched. Returns `undefined`/the input as-is when empty.
 */
function decryptExtraFields(
  providerType: ProviderType | string,
  extraFields: Record<string, string> | undefined,
  providerName: string,
): Record<string, string> | undefined {
  if (!extraFields) return extraFields
  const secrets = secretExtraFieldKeys(providerType)
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(extraFields)) {
    out[key] = secrets.has(key)
      ? (tryDecryptField(value, `extra field "${key}" for provider "${providerName}"`) ?? value)
      : value
  }
  return out
}

/**
 * Encrypt + sanitize an incoming `extraFields` record for storage: drops empty
 * values and unknown keys, encrypts fields declared `secret`. Returns
 * `undefined` when nothing remains.
 */
function sanitizeExtraFieldsForStorage(
  providerType: ProviderType | string,
  extraFields: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!extraFields) return undefined
  const defs = getProviderExtraFieldDefs(providerType)
  const knownKeys = new Set(defs.map(f => f.key))
  const secrets = new Set(defs.filter(f => f.secret).map(f => f.key))
  const out: Record<string, string> = {}
  for (const [key, raw] of Object.entries(extraFields)) {
    if (!knownKeys.has(key)) continue
    const trimmed = (raw ?? '').trim()
    if (!trimmed) continue
    out[key] = secrets.has(key) ? encrypt(trimmed) : trimmed
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * Merge incoming extra-field edits into the currently-stored record. Secret
 * fields left blank keep their existing (encrypted) value; non-secret fields
 * set to blank are cleared. Unknown keys are pruned.
 */
function mergeExtraFieldsForUpdate(
  providerType: ProviderType | string,
  current: Record<string, string> | undefined,
  incoming: Record<string, string>,
): Record<string, string> | undefined {
  const defs = getProviderExtraFieldDefs(providerType)
  const knownKeys = new Set(defs.map(f => f.key))
  const secrets = new Set(defs.filter(f => f.secret).map(f => f.key))
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(current ?? {})) {
    if (knownKeys.has(key)) out[key] = value
  }
  for (const [key, raw] of Object.entries(incoming)) {
    if (!knownKeys.has(key)) continue
    const trimmed = (raw ?? '').trim()
    if (secrets.has(key)) {
      if (trimmed) out[key] = encrypt(trimmed)
    } else if (trimmed) {
      out[key] = trimmed
    } else {
      delete out[key]
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * Produce a client-safe view of a provider's extra fields: non-secret values
 * pass through, secret values are omitted and reported as a presence boolean
 * in `extraFieldsSet`. Expects the decrypted record.
 */
export function maskProviderExtraFields(
  providerType: ProviderType | string,
  extraFields: Record<string, string> | undefined,
): { extraFields: Record<string, string>; extraFieldsSet: Record<string, boolean> } {
  const defs = getProviderExtraFieldDefs(providerType)
  const knownKeys = new Set(defs.map(f => f.key))
  const secrets = new Set(defs.filter(f => f.secret).map(f => f.key))
  const masked: Record<string, string> = {}
  const set: Record<string, boolean> = {}
  for (const [key, value] of Object.entries(extraFields ?? {})) {
    if (!knownKeys.has(key)) continue
    if (secrets.has(key)) set[key] = Boolean(value)
    else masked[key] = value
  }
  return { extraFields: masked, extraFieldsSet: set }
}

/**
 * Load providers.json from config directory
 */
export function loadProviders(): ProvidersFile {
  const configDir = getConfigDir()
  const filePath = path.join(configDir, 'providers.json')

  if (!fs.existsSync(filePath)) {
    return { providers: [] }
  }

  const content = fs.readFileSync(filePath, 'utf-8')
  const data = JSON.parse(content) as ProvidersFile

  // Migrate legacy ollama-local / ollama-cloud → ollama
  let migrated = false
  for (const p of data.providers) {
    if (p.providerType === 'ollama-local' || p.providerType === 'ollama-cloud') {
      p.providerType = 'ollama' as ProviderType
      p.type = 'openai-completions'
      p.provider = 'ollama'
      migrated = true
    }

    // Migrate the former single custom preset → its Chat Completions successor
    if ((p.providerType as string) === 'openai-compatible') {
      p.providerType = 'custom-openai-completions'
      p.provider = 'custom'
      migrated = true
    }

    // Migrate legacy `defaultModel` into enabledModels. The dedicated field is
    // gone; the default is now enabledModels[0]. Older configs may store the
    // default at a non-zero index (or omit enabledModels entirely), so fold it
    // to the front to preserve the previously selected default.
    const legacy = p as ProviderConfig & { defaultModel?: string }
    if (legacy.defaultModel !== undefined) {
      const defaultModel = legacy.defaultModel
      const rest = (legacy.enabledModels ?? []).filter(m => m !== defaultModel)
      legacy.enabledModels = defaultModel ? [defaultModel, ...rest] : rest
      delete legacy.defaultModel
      migrated = true
    }

    if (moveImageOnlyIdsToImageModels(p, data)) migrated = true
  }
  if (migrated) {
    // Persist the migration so it only runs once
    const outPath = path.join(configDir, 'providers.json')
    fs.writeFileSync(outPath, JSON.stringify(data, null, 2) + '\n', 'utf-8')
  }

  return data
}

/**
 * Before image models had their own list, image-only ids could only be added
 * as text models, where every chat request to them fails. They are moved to
 * `enabledImageModels`; the active and fallback selection stay untouched so a
 * running chat setup never changes underneath the user.
 */
function moveImageOnlyIdsToImageModels(provider: ProviderConfig, file: ProvidersFile): boolean {
  const enabled = provider.enabledModels ?? []
  if (enabled.length === 0) return false
  const isImageOnly = createImageOnlyModelIdMatcher(provider.providerType)

  const pinned = new Set<string>()
  if (file.activeProvider === provider.id) pinned.add(file.activeModel ?? getProviderDefaultModel(provider))
  if (file.fallbackProvider === provider.id) pinned.add(file.fallbackModel ?? getProviderDefaultModel(provider))

  const moved = enabled.filter(id => !pinned.has(id) && isImageOnly(id))
  if (moved.length === 0) return false

  provider.enabledModels = enabled.filter(id => !moved.includes(id))
  provider.enabledImageModels = Array.from(new Set([...(provider.enabledImageModels ?? []), ...moved]))
  if (provider.disabledModels) {
    provider.disabledModels = provider.disabledModels.filter(id => !moved.includes(id))
    if (provider.disabledModels.length === 0) delete provider.disabledModels
  }
  return true
}

/**
 * Save providers.json to config directory
 */
export function saveProviders(data: ProvidersFile): void {
  const configDir = getConfigDir()
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true })
  }
  const filePath = path.join(configDir, 'providers.json')
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8')
}

/**
 * Get providers with API keys decrypted
 */
export function loadProvidersDecrypted(): ProvidersFile {
  const file = loadProviders()
  return {
    ...file,
    providers: file.providers.map(p => {
      // Sync fixed URLs from presets (handles preset URL changes)
      const preset = PROVIDER_TYPE_PRESETS[p.providerType]
      const baseUrl = (preset && !preset.urlEditable) ? preset.baseUrl : p.baseUrl

      const decryptedApiKey = tryDecryptField(p.apiKey, `API key for provider "${p.name}"`) ?? p.apiKey
      const decryptedExtraFields = decryptExtraFields(p.providerType, p.extraFields, p.name)

      let decryptedOAuth: OAuthCredentialsStored | undefined
      if (p.oauthCredentials) {
        try {
          decryptedOAuth = decryptOAuthCredentials(p.oauthCredentials)
        } catch (err) {
          console.warn(`[axiom] Skipping OAuth credentials for provider "${p.name}": ${(err as Error).message}`)
          decryptedOAuth = undefined
        }
      }

      return {
        ...p,
        baseUrl,
        apiKey: decryptedApiKey,
        extraFields: decryptedExtraFields,
        oauthCredentials: decryptedOAuth,
      }
    }),
  }
}

/**
 * Get providers with API keys masked for display
 */
export type MaskedProviderConfig = ProviderConfig & {
  apiKeyMasked: string
  extraFieldsSet: Record<string, boolean>
}

export type MaskedProvidersFile = Omit<ProvidersFile, 'providers'> & {
  providers: MaskedProviderConfig[]
}

export function loadProvidersMasked(): MaskedProvidersFile {
  const file = loadProvidersDecrypted() // Already syncs URLs from presets
  return {
    ...file,
    providers: file.providers.map(p => {
      const { extraFields, extraFieldsSet } = maskProviderExtraFields(p.providerType, p.extraFields)
      return {
        ...p,
        apiKey: '', // Never send real key to frontend
        apiKeyMasked: p.apiKey ? maskApiKey(p.apiKey) : '',
        extraFields,
        extraFieldsSet,
        oauthCredentials: p.oauthCredentials ? { refresh: '', access: '', expires: p.oauthCredentials.expires } : undefined,
      }
    }),
  }
}

/**
 * Encrypt OAuth credentials for storage
 */
export function encryptOAuthCredentials(creds: OAuthCredentials): OAuthCredentialsStored {
  const { refresh, access, expires, ...extra } = creds
  return {
    refresh: encrypt(refresh),
    access: encrypt(access),
    expires,
    extra: Object.keys(extra).length > 0 ? encrypt(JSON.stringify(extra)) : undefined,
  }
}

/**
 * Attempt to decrypt a single encrypted field, returning `undefined` on
 * failure (logs a warning). Lets callers skip unreadable fields instead of
 * bringing down the entire server when e.g. the encryption key rotated.
 */
function tryDecryptField(value: string | undefined, label: string): string | undefined {
  if (!value) return value
  if (!isEncrypted(value)) return value
  try {
    return decrypt(value)
  } catch (err) {
    console.warn(`[axiom] Failed to decrypt ${label}: ${(err as Error).message}. Field will be treated as absent. Set ENCRYPTION_KEY correctly or re-enter the value via the web UI.`)
    return undefined
  }
}

/**
 * Decrypt OAuth credentials from storage. Individual fields that fail to
 * decrypt are dropped with a warning rather than throwing — this keeps the
 * server booting even when a stale `providers.json` has credentials
 * encrypted under a previous key.
 */
function decryptOAuthCredentials(stored: OAuthCredentialsStored): OAuthCredentialsStored {
  return {
    refresh: tryDecryptField(stored.refresh, 'OAuth refresh token') ?? stored.refresh,
    access: tryDecryptField(stored.access, 'OAuth access token') ?? stored.access,
    expires: stored.expires,
    extra: stored.extra ? (tryDecryptField(stored.extra, 'OAuth extra payload') ?? stored.extra) : stored.extra,
  }
}

/**
 * Convert stored OAuth credentials to pi-ai OAuthCredentials format
 */
export function storedToOAuthCredentials(stored: OAuthCredentialsStored): OAuthCredentials {
  const base: OAuthCredentials = {
    refresh: stored.refresh,
    access: stored.access,
    expires: stored.expires,
  }
  if (stored.extra) {
    try {
      const extraFields = JSON.parse(stored.extra) as Record<string, unknown>
      Object.assign(base, extraFields)
    } catch {
      // Ignore parse errors
    }
  }
  return base
}

/**
 * Generate a unique provider ID
 */
function generateProviderId(): string {
  return crypto.randomUUID()
}

/**
 * Add a new provider (API key based)
 */
export function addProvider(input: {
  name: string
  providerType: ProviderType
  baseUrl?: string
  apiKey?: string
  enabledModels: string[]
  degradedThresholdMs?: number
  textVerbosity?: TextVerbosity
  transport?: ProviderTransport
  extraFields?: Record<string, string>
  compat?: Record<string, unknown> | null
}): ProviderConfig {
  const preset = PROVIDER_TYPE_PRESETS[input.providerType]
  if (!preset) {
    throw new Error(`Unknown provider type: ${input.providerType}`)
  }
  const compat = resolveCustomCompat(preset, input.compat)

  const file = loadProviders()

  // Check for duplicate name
  if (file.providers.some(p => p.name === input.name)) {
    throw new Error(`Provider with name "${input.name}" already exists`)
  }

  // Models may be added after creation via the "Add Model" flow, so a provider
  // can be created with no enabled models yet.
  const enabledModels = input.enabledModels ?? []

  const provider: ProviderConfig = {
    id: generateProviderId(),
    name: input.name,
    type: preset.apiType,
    providerType: input.providerType,
    provider: preset.providerName,
    baseUrl: input.baseUrl || preset.baseUrl,
    apiKey: input.apiKey ? encrypt(input.apiKey) : '',
    enabledModels,
    degradedThresholdMs: input.degradedThresholdMs ?? 5000,
    ...(input.textVerbosity && presetSupportsTextVerbosity(input.providerType)
      && { textVerbosity: input.textVerbosity }),
    ...(input.transport && input.transport !== 'sse' && presetSupportsTransport(input.providerType)
      && { transport: input.transport }),
    ...((() => {
      const extra = sanitizeExtraFieldsForStorage(input.providerType, input.extraFields)
      return extra ? { extraFields: extra } : {}
    })()),
    ...(compat && { compat }),
    status: 'untested',
    authMethod: preset.authMethod,
  }

  file.providers.push(provider)

  // If this is the first provider, make it active
  if (file.providers.length === 1) {
    file.activeProvider = provider.id
    if (enabledModels[0]) file.activeModel = enabledModels[0]
  }

  saveProviders(file)
  return provider
}

/**
 * Add a new OAuth-authenticated provider
 */
export function addOAuthProvider(input: {
  name: string
  providerType: ProviderType
  enabledModels: string[]
  degradedThresholdMs?: number
  textVerbosity?: TextVerbosity
  transport?: ProviderTransport
  oauthCredentials: OAuthCredentials
}): ProviderConfig {
  const preset = PROVIDER_TYPE_PRESETS[input.providerType]
  if (!preset) {
    throw new Error(`Unknown provider type: ${input.providerType}`)
  }
  if (preset.authMethod !== 'oauth') {
    throw new Error(`Provider type "${input.providerType}" does not use OAuth`)
  }

  const file = loadProviders()

  // Check for duplicate name
  if (file.providers.some(p => p.name === input.name)) {
    throw new Error(`Provider with name "${input.name}" already exists`)
  }

  const enabledModels = input.enabledModels ?? []

  const provider: ProviderConfig = {
    id: generateProviderId(),
    name: input.name,
    type: preset.apiType,
    providerType: input.providerType,
    provider: preset.providerName,
    baseUrl: preset.baseUrl,
    apiKey: '',
    enabledModels,
    degradedThresholdMs: input.degradedThresholdMs ?? 5000,
    ...(input.textVerbosity && presetSupportsTextVerbosity(input.providerType)
      && { textVerbosity: input.textVerbosity }),
    ...(input.transport && input.transport !== 'sse' && presetSupportsTransport(input.providerType)
      && { transport: input.transport }),
    status: 'untested',
    authMethod: 'oauth',
    oauthCredentials: encryptOAuthCredentials(input.oauthCredentials),
  }

  file.providers.push(provider)

  if (file.providers.length === 1) {
    file.activeProvider = provider.id
    if (enabledModels[0]) file.activeModel = enabledModels[0]
  }

  saveProviders(file)
  return provider
}

/**
 * Update an existing provider
 */
export function updateProvider(id: string, input: {
  name?: string
  providerType?: ProviderType
  baseUrl?: string
  apiKey?: string
  enabledModels?: string[]
  enabledImageModels?: string[]
  degradedThresholdMs?: number
  textVerbosity?: TextVerbosity | null
  transport?: ProviderTransport | null
  extraFields?: Record<string, string>
  compat?: Record<string, unknown> | null
}): ProviderConfig {
  const file = loadProviders()
  const index = file.providers.findIndex(p => p.id === id)
  if (index === -1) {
    throw new Error(`Provider not found: ${id}`)
  }

  const existing = file.providers[index]

  // Check for duplicate name (if name is being changed)
  if (input.name && input.name !== existing.name && file.providers.some(p => p.name === input.name)) {
    throw new Error(`Provider with name "${input.name}" already exists`)
  }

  const providerTypeChanged = Boolean(input.providerType && input.providerType !== existing.providerType)

  // If providerType is being changed, update derived fields
  if (providerTypeChanged && input.providerType) {
    const preset = PROVIDER_TYPE_PRESETS[input.providerType]
    if (!preset) {
      throw new Error(`Unknown provider type: ${input.providerType}`)
    }
    if (getImageApiForType(existing.providerType) !== getImageApiForType(input.providerType)) {
      delete existing.enabledImageModels
      delete existing.disabledImageModels
    }
    existing.providerType = input.providerType
    existing.type = preset.apiType
    existing.provider = preset.providerName
    existing.authMethod = preset.authMethod
    delete existing.extraFields
    delete existing.compat
    if (!input.baseUrl) {
      existing.baseUrl = preset.baseUrl
    }
  }

  if (input.name !== undefined) existing.name = input.name
  if (input.baseUrl !== undefined) existing.baseUrl = input.baseUrl
  if (input.apiKey !== undefined) existing.apiKey = input.apiKey ? encrypt(input.apiKey) : ''
  if (input.enabledModels !== undefined) {
    existing.enabledModels = input.enabledModels
    if (existing.disabledModels) {
      existing.disabledModels = existing.disabledModels.filter(m => input.enabledModels!.includes(m))
      if (existing.disabledModels.length === 0) delete existing.disabledModels
    }
  }
  if (input.enabledImageModels !== undefined) {
    const imageModels = Array.from(new Set(input.enabledImageModels.map(id => id.trim()).filter(Boolean)))
    if (imageModels.length > 0 && !supportsImageModels(existing.providerType)) {
      throw new Error(`Provider type "${existing.providerType}" does not support image generation models`)
    }
    if (imageModels.length > 0) existing.enabledImageModels = imageModels
    else delete existing.enabledImageModels
    pruneDisabledImageModels(existing)
  }
  if (input.degradedThresholdMs !== undefined) existing.degradedThresholdMs = input.degradedThresholdMs
  if (input.extraFields !== undefined) {
    existing.extraFields = mergeExtraFieldsForUpdate(existing.providerType, existing.extraFields, input.extraFields)
  }
  if (input.textVerbosity !== undefined) {
    if (input.textVerbosity === null || !presetSupportsTextVerbosity(existing.providerType)) {
      // Either the caller explicitly cleared the value or the (possibly
      // newly-changed) provider type does not consume textVerbosity. In
      // both cases we drop it rather than persisting a no-op.
      delete existing.textVerbosity
    } else {
      existing.textVerbosity = input.textVerbosity
    }
  } else if (existing.textVerbosity && !presetSupportsTextVerbosity(existing.providerType)) {
    // Provider type was switched to one that does not support textVerbosity
    // — strip the now-orphaned value so it does not silently persist.
    delete existing.textVerbosity
  }
  if (input.transport !== undefined) {
    if (input.transport === null || input.transport === 'sse' || !presetSupportsTransport(existing.providerType)) {
      // Caller explicitly cleared, asked for the SSE default, or switched to
      // a provider type that does not consume `transport`. In all three
      // cases we drop the field rather than persisting a no-op.
      delete existing.transport
    } else {
      existing.transport = input.transport
    }
  } else if (existing.transport && !presetSupportsTransport(existing.providerType)) {
    // Provider type was switched to one that does not support transport
    // — strip the now-orphaned value so it does not silently persist.
    delete existing.transport
  }

  const currentPreset = PROVIDER_TYPE_PRESETS[existing.providerType]
  if (input.compat !== undefined && currentPreset) {
    const compat = resolveCustomCompat(currentPreset, input.compat)
    if (compat) existing.compat = compat
    else delete existing.compat
  }

  // For providers with fixed URLs, always sync from preset
  if (currentPreset && !currentPreset.urlEditable) {
    existing.baseUrl = currentPreset.baseUrl
  }

  // Reset status when config changes
  existing.status = 'untested'

  file.providers[index] = existing
  saveProviders(file)
  return existing
}

/** Compat options are validated against the preset's wire API; other presets never store them. */
function resolveCustomCompat(
  preset: ProviderTypePreset,
  compat: Record<string, unknown> | null | undefined,
): Record<string, unknown> | undefined {
  if (!compat || !preset.custom) return undefined
  const validated = validateModelCompat(preset.apiType as CompatApiTypeContract, compat)
  if (!validated.ok) throw new Error(validated.error)
  return Object.keys(validated.value).length > 0 ? validated.value : undefined
}

/** Thrown when a provider id does not resolve to a configured provider. */
export class ProviderNotFoundError extends Error {
  constructor(providerId: string) {
    super(`Provider not found: ${providerId}`)
    this.name = 'ProviderNotFoundError'
  }
}

/**
 * Patch a single model entry within a provider's `models[]` array, creating
 * the entry on the fly when it does not exist yet. The entry only stores the
 * patched fields; `buildModel()` resolves everything else from the local
 * overrides and the (refreshable) catalog.
 */
export function updateProviderModel(
  providerId: string,
  modelId: string,
  patch: ProviderModelUpdatePayloadContract,
): ProviderConfig {
  const file = loadProviders()
  const provider = file.providers.find(p => p.id === providerId)
  if (!provider) {
    throw new ProviderNotFoundError(providerId)
  }

  if (!provider.models) provider.models = []
  let entry = provider.models.find(m => m.id === modelId)
  if (!entry) {
    entry = { id: modelId }
    provider.models.push(entry)
  }

  const setText = (key: 'name' | 'description', value: string | undefined) => {
    if (value === undefined) return
    const trimmed = value.trim()
    if (trimmed) entry[key] = trimmed
    else delete entry[key]
  }
  setText('name', patch.name)
  setText('description', patch.description)

  const setOverride = <K extends 'contextWindow' | 'maxTokens' | 'reasoning' | 'input' | 'output' | 'thinkingLevelMap'>(
    key: K,
    value: ProviderModelConfig[K] | null | undefined,
  ) => {
    if (value === undefined) return
    if (value === null) delete entry[key]
    else entry[key] = value
  }
  setOverride('contextWindow', patch.contextWindow !== undefined && patch.contextWindow !== null && patch.contextWindow <= 0 ? undefined : patch.contextWindow)
  setOverride('maxTokens', patch.maxTokens !== undefined && patch.maxTokens !== null && patch.maxTokens <= 0 ? undefined : patch.maxTokens)
  setOverride('reasoning', patch.reasoning)
  setOverride('input', patch.input?.length === 0 ? undefined : patch.input && [...patch.input])
  setOverride('output', patch.output?.length === 0 ? undefined : patch.output && [...patch.output])
  setOverride('thinkingLevelMap', patch.thinkingLevelMap && { ...patch.thinkingLevelMap })

  if (patch.cost) {
    const cost = { ...entry.cost }
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
      const value = patch.cost[key]
      if (value === null) delete cost[key]
      else if (value !== undefined) cost[key] = value
    }
    if (Object.keys(cost).length > 0) entry.cost = cost
    else delete entry.cost
  }

  applyCompactionOverridePatch(entry, patch.compaction)

  if (Object.keys(entry).length === 1) {
    provider.models = provider.models.filter(m => m !== entry)
  }

  saveProviders(file)
  return provider
}

function applyCompactionOverridePatch(
  entry: ProviderModelConfig,
  patch: ProviderModelUpdatePayloadContract['compaction'],
): void {
  if (patch === undefined) return
  if (patch === null) {
    delete entry.compaction
    return
  }
  const compaction = { ...entry.compaction }
  for (const key of ['reserveTokens', 'keepRecentTokens'] as const) {
    const value = patch[key]
    if (value === null) delete compaction[key]
    else if (value !== undefined) compaction[key] = value
  }
  if (Object.keys(compaction).length > 0) entry.compaction = compaction
  else delete entry.compaction
}

/** The user's per-model compaction budget override, if any. */
export function getModelCompactionOverride(
  provider: Pick<ProviderConfig, 'providerType' | 'models'> | null | undefined,
  modelId: string,
): ModelCompactionOverrideContract | undefined {
  if (!provider) return undefined
  return provider.models?.find(m => m.id === modelId)?.compaction
}

/** Reads `providers.json` fresh, so edits apply without restarting running agents. */
export function loadModelCompactionOverride(
  providerId: string | null | undefined,
  modelId: string,
): ModelCompactionOverrideContract | undefined {
  if (!providerId) return undefined
  try {
    return getModelCompactionOverride(loadProviders().providers.find(p => p.id === providerId), modelId)
  } catch (err) {
    console.warn('[compaction] Failed to read model compaction override:', err)
    return undefined
  }
}

/**
 * Update OAuth credentials for a provider
 */
export function updateOAuthCredentials(id: string, credentials: OAuthCredentials): void {
  const file = loadProviders()
  const provider = file.providers.find(p => p.id === id)
  if (!provider) return
  provider.oauthCredentials = encryptOAuthCredentials(credentials)
  saveProviders(file)
}

/**
 * Delete a provider
 */
export function deleteProvider(id: string): void {
  const file = loadProviders()
  const index = file.providers.findIndex(p => p.id === id)
  if (index === -1) {
    throw new Error(`Provider not found: ${id}`)
  }

  // Cannot delete the active provider
  if (file.activeProvider === id) {
    throw new Error('Cannot delete the active provider. Set another provider as active first.')
  }

  // Clean up fallback if it points to this provider
  if (file.fallbackProvider === id) {
    delete file.fallbackProvider
    delete file.fallbackModel
  }

  file.providers.splice(index, 1)
  saveProviders(file)
}

function resolveSelectedModel(file: ProvidersFile, providerId: string | undefined, modelId: string | undefined): string | undefined {
  if (!providerId) return undefined
  const provider = file.providers.find(p => p.id === providerId)
  if (!provider) return undefined
  return modelId ?? (getProviderDefaultModel(provider) || undefined)
}

function assertNotActiveSelection(file: ProvidersFile, providerId: string, modelId?: string): void {
  if (file.activeProvider !== providerId) return
  const activeModel = resolveSelectedModel(file, file.activeProvider, file.activeModel)
  if (modelId === undefined) {
    throw new Error('Cannot disable the active provider. Set another provider as active first.')
  }
  if (activeModel === modelId) {
    throw new Error('Cannot disable the active model. Set another model as active first.')
  }
}

function clearFallbackIfUnusable(file: ProvidersFile): void {
  if (!file.fallbackProvider) return
  const provider = file.providers.find(p => p.id === file.fallbackProvider)
  if (!provider) return
  const fallbackModel = resolveSelectedModel(file, file.fallbackProvider, file.fallbackModel)
  if (!isProviderModelUsable(provider, fallbackModel)) {
    delete file.fallbackProvider
    delete file.fallbackModel
  }
}

/**
 * Enable or disable a provider for LLM use. Disabling the active provider is
 * rejected; a fallback pointing at it is cleared.
 */
export function setProviderDisabled(id: string, disabled: boolean): ProviderConfig {
  const file = loadProviders()
  const provider = file.providers.find(p => p.id === id)
  if (!provider) throw new ProviderNotFoundError(id)

  if (disabled) {
    assertNotActiveSelection(file, id)
    provider.disabled = true
    clearFallbackIfUnusable(file)
  } else {
    delete provider.disabled
  }

  saveProviders(file)
  return provider
}

/**
 * Enable or disable a single text or image model of a provider. Disabling the
 * active model is rejected; a fallback pointing at it is cleared. An id can be
 * both a text and an image model, so `modelType` picks the list; without it,
 * the text list wins when the id is in both.
 */
export function setProviderModelDisabled(
  providerId: string,
  modelId: string,
  disabled: boolean,
  modelType?: ProviderModelTypeContract,
): ProviderConfig {
  const file = loadProviders()
  const provider = file.providers.find(p => p.id === providerId)
  if (!provider) throw new ProviderNotFoundError(providerId)
  const isTextModel = (provider.enabledModels ?? []).includes(modelId)
  const isImageModel = (provider.enabledImageModels ?? []).includes(modelId)
  const target = modelType ?? (isTextModel || !isImageModel ? 'text' : 'image')
  if (target === 'image') {
    if (!isImageModel) throw new Error(`Image model "${modelId}" is not configured for provider "${provider.name}"`)
    setImageModelDisabled(provider, modelId, disabled)
    saveProviders(file)
    return provider
  }
  if (!isTextModel) {
    throw new Error(`Model "${modelId}" is not configured for provider "${provider.name}"`)
  }

  const current = new Set(provider.disabledModels ?? [])
  if (disabled) {
    assertNotActiveSelection(file, providerId, modelId)
    current.add(modelId)
  } else {
    current.delete(modelId)
  }

  if (current.size > 0) {
    provider.disabledModels = (provider.enabledModels ?? []).filter(m => current.has(m))
  } else {
    delete provider.disabledModels
  }
  if (disabled) clearFallbackIfUnusable(file)

  saveProviders(file)
  return provider
}

function setImageModelDisabled(provider: ProviderConfig, modelId: string, disabled: boolean): void {
  const current = new Set(provider.disabledImageModels ?? [])
  if (disabled) current.add(modelId)
  else current.delete(modelId)
  provider.disabledImageModels = [...current]
  pruneDisabledImageModels(provider)
}

function pruneDisabledImageModels(provider: ProviderConfig): void {
  if (!provider.disabledImageModels) return
  const enabled = provider.enabledImageModels ?? []
  provider.disabledImageModels = enabled.filter(m => provider.disabledImageModels!.includes(m))
  if (provider.disabledImageModels.length === 0) delete provider.disabledImageModels
}

function assertSelectable(provider: ProviderConfig, modelId: string | undefined): void {
  if (isProviderDisabled(provider)) {
    throw new Error(`Provider "${provider.name}" is disabled`)
  }
  if (modelId && isModelDisabled(provider, modelId)) {
    throw new Error(`Model "${modelId}" is disabled for provider "${provider.name}"`)
  }
}

/**
 * Set the active provider
 */
export function setActiveProvider(id: string, modelId?: string): void {
  const file = loadProviders()
  const provider = file.providers.find(p => p.id === id)
  if (!provider) {
    throw new Error(`Provider not found: ${id}`)
  }
  const resolvedModel = modelId ?? getProviderDefaultModel(provider)
  assertSelectable(provider, resolvedModel)
  file.activeProvider = id
  file.activeModel = resolvedModel
  saveProviders(file)
}

/**
 * Set the active model ID (within the current active provider).
 */
export function setActiveModel(modelId: string): void {
  const file = loadProviders()
  if (!file.activeProvider) {
    throw new Error('No active provider set')
  }
  const provider = file.providers.find(p => p.id === file.activeProvider)
  if (!provider) {
    throw new Error('Active provider not found')
  }
  const enabled = provider.enabledModels ?? []
  if (!enabled.includes(modelId)) {
    throw new Error(`Model "${modelId}" is not enabled for provider "${provider.name}"`)
  }
  assertSelectable(provider, modelId)
  file.activeModel = modelId
  saveProviders(file)
}

/**
 * Get the active model ID.
 */
export function getActiveModelId(): string | null {
  const file = loadProviders()
  if (!file.activeProvider) return null
  const provider = file.providers.find(p => p.id === file.activeProvider)
  if (!provider) return null
  return file.activeModel ?? (getProviderDefaultModel(provider) || null)
}

/**
 * Update a provider's status
 */
export function updateProviderStatus(id: string, status: 'connected' | 'error' | 'untested', modelId?: string): void {
  const file = loadProviders()
  const provider = file.providers.find(p => p.id === id)
  if (!provider) return

  if (modelId) {
    // Update per-model status
    if (!provider.modelStatuses) provider.modelStatuses = {}
    provider.modelStatuses[modelId] = status
    // Image-model results (content refusals, no live endpoint) must not flag a working chat provider.
    const textModels = provider.enabledModels ?? []
    const enabled = textModels.length > 0 ? textModels : (provider.enabledImageModels ?? [])
    const statuses = enabled.map(m => provider.modelStatuses?.[m] ?? 'untested')
    if (statuses.every(s => s === 'connected')) provider.status = 'connected'
    else if (statuses.some(s => s === 'error')) provider.status = 'error'
    else provider.status = 'untested'
  } else {
    provider.status = status
  }

  saveProviders(file)
}

/**
 * Get the fallback provider configuration (decrypted), or null if not configured.
 */
export function getFallbackProvider(): ProviderConfig | null {
  const file = loadProvidersDecrypted()
  if (!file.fallbackProvider) return null

  const found = file.providers.find(p => p.id === file.fallbackProvider)
  return found ?? null
}

/**
 * Set the fallback provider by ID. Validates that the ID exists and is not the active provider.
 */
export function setFallbackProvider(id: string, modelId?: string): void {
  const file = loadProviders()
  const provider = file.providers.find(p => p.id === id)
  if (!provider) {
    throw new Error(`Provider not found: ${id}`)
  }
  assertSelectable(provider, modelId ?? getProviderDefaultModel(provider))
  if (file.activeProvider === id) {
    // Only reject if both provider AND model match the active selection
    const activeProviderConfig = file.providers.find(p => p.id === file.activeProvider)
    const activeModel = file.activeModel ?? (activeProviderConfig ? getProviderDefaultModel(activeProviderConfig) : undefined)
    const fbModel = modelId ?? getProviderDefaultModel(provider)
    if (activeModel === fbModel) {
      throw new Error('Fallback cannot be the same provider and model as the active selection')
    }
  }
  file.fallbackProvider = id
  if (modelId !== undefined) {
    file.fallbackModel = modelId
  } else {
    file.fallbackModel = getProviderDefaultModel(provider)
  }
  saveProviders(file)
}

/**
 * Clear the fallback provider setting.
 */
export function clearFallbackProvider(): void {
  const file = loadProviders()
  delete file.fallbackProvider
  delete file.fallbackModel
  saveProviders(file)
}

/**
 * Get the fallback model ID.
 */
export function getFallbackModelId(): string | null {
  const file = loadProviders()
  if (!file.fallbackProvider) return null
  const provider = file.providers.find(p => p.id === file.fallbackProvider)
  if (!provider) return null
  return file.fallbackModel ?? (getProviderDefaultModel(provider) || null)
}

/**
 * Get the active provider configuration
 */
export function getActiveProvider(): ProviderConfig | null {
  const file = loadProvidersDecrypted()
  if (file.providers.length === 0) return null

  if (file.activeProvider) {
    const found = file.providers.find(p => p.id === file.activeProvider)
    if (found) return found
  }

  return file.providers.find(p => !isProviderDisabled(p)) ?? file.providers[0]
}

/**
 * Get API key for a provider, handling OAuth token refresh
 */
export async function getApiKeyForProvider(provider: ProviderConfig): Promise<string> {
  // API key providers: return the key directly
  if (provider.authMethod !== 'oauth' || !provider.oauthCredentials) {
    // For providers that don't require an API key (e.g., local Ollama),
    // return a dummy key to satisfy downstream libraries (like the OpenAI SDK)
    // that require a non-empty API key string.
    if (!provider.apiKey) {
      const preset = PROVIDER_TYPE_PRESETS[provider.providerType]
      if (preset && !preset.requiresApiKey) {
        return 'no-key'
      }
    }
    return provider.apiKey
  }

  const preset = PROVIDER_TYPE_PRESETS[provider.providerType]
  if (!preset?.oauthProviderId) {
    return provider.apiKey
  }

  // Convert stored credentials to pi-ai format
  const oauthCreds = storedToOAuthCredentials(provider.oauthCredentials)

  // Use pi-ai to get API key (auto-refreshes expired tokens)
  const result = await getOAuthApiKey(preset.oauthProviderId, oauthCreds)

  if (!result) {
    throw new Error(`Failed to get API key for OAuth provider ${provider.name}. Re-login may be required.`)
  }

  // Save refreshed credentials if they changed
  if (result.newCredentials.access !== oauthCreds.access ||
      result.newCredentials.expires !== oauthCreds.expires) {
    updateOAuthCredentials(provider.id, result.newCredentials)
  }

  return result.apiKey
}

/**
 * Build a pi-ai Model object from a provider config
 */
export function getConfiguredPriceTable(): TokenPriceTable {
  try {
    ensureConfigTemplates()
    const settings = loadConfig<{ tokenPriceTable?: TokenPriceTable }>('settings.json')
    return {
      ...DEFAULT_PRICE_TABLE,
      ...(settings.tokenPriceTable ?? {}),
    }
  } catch {
    return { ...DEFAULT_PRICE_TABLE }
  }
}

/**
 * The provider's default/primary model id. Historically a dedicated
 * `defaultModel` field; now derived as the first enabled model.
 */
export function getProviderDefaultModel(provider: Pick<ProviderConfig, 'enabledModels' | 'disabledModels'>): string {
  const enabled = provider.enabledModels ?? []
  // Falls back to the first entry when every model is disabled so provider
  // clones pinned to a single model (`{ ...p, enabledModels: [id] }`) keep
  // resolving to that model.
  return enabled.find(m => !provider.disabledModels?.includes(m)) ?? enabled[0] ?? ''
}

export function isProviderDisabled(provider: Pick<ProviderConfig, 'disabled'>): boolean {
  return provider.disabled === true
}

export function isModelDisabled(provider: Pick<ProviderConfig, 'disabledModels'>, modelId: string): boolean {
  return provider.disabledModels?.includes(modelId) ?? false
}

/** Models of a provider that may be offered to the agent and in LLM model pickers. */
export function getUsableModels(provider: Pick<ProviderConfig, 'enabledModels' | 'disabled' | 'disabledModels'>): string[] {
  if (isProviderDisabled(provider)) return []
  return (provider.enabledModels ?? []).filter(m => !isModelDisabled(provider, m))
}

/**
 * Whether `modelId` (or the provider's default model when omitted) may be used
 * for LLM work. False for disabled providers, disabled models, and providers
 * without any usable model.
 */
export function isProviderModelUsable(
  provider: Pick<ProviderConfig, 'enabledModels' | 'disabled' | 'disabledModels'>,
  modelId?: string,
): boolean {
  if (isProviderDisabled(provider)) return false
  if (modelId) return !isModelDisabled(provider, modelId)
  return getUsableModels(provider).length > 0
}

/** Image generation models of a provider that may be offered to the agent and the default-image-model picker. */
export function getUsableImageModels(provider: Pick<ProviderConfig, 'providerType' | 'enabledImageModels' | 'disabledImageModels' | 'disabled'>): string[] {
  if (isProviderDisabled(provider) || !supportsImageModels(provider.providerType)) return []
  return (provider.enabledImageModels ?? []).filter(m => !isImageModelDisabled(provider, m))
}

function isImageModelDisabled(provider: Pick<ProviderConfig, 'disabledImageModels'>, modelId: string): boolean {
  return provider.disabledImageModels?.includes(modelId) ?? false
}

/** Whether `modelId` may be used as an image generation model of this provider. */
export function isProviderImageModelUsable(provider: Pick<ProviderConfig, 'disabled' | 'disabledImageModels'>, modelId: string): boolean {
  return !isProviderDisabled(provider) && !isImageModelDisabled(provider, modelId)
}

/**
 * pi-ai image model for an enabled image model id. Ids missing from the
 * bundled catalog (newer upstream models) are built on the provider's image
 * API with image-only output, which every image model supports, unless the
 * modalities were stored when the model was added from a live list.
 */
export function buildImageModel(provider: ProviderConfig, modelId: string): ImageModel<ImageApi> {
  const catalog = getImageCatalogForType(provider.providerType)
  const template = catalog.find(m => m.id === modelId) ?? catalog[0]
  if (!template) {
    throw new Error(`Provider "${provider.name}" does not support image generation`)
  }
  const isCatalogModel = template.id === modelId
  const entry = provider.models?.find(m => m.id === modelId)
  const input: ImageModel<ImageApi>['input'] = entry?.input ?? (isCatalogModel ? template.input : ['text', 'image'])
  const output: ImageModel<ImageApi>['output'] = entry?.output?.includes('image') ? entry.output : (isCatalogModel ? template.output : ['image'])
  return {
    ...template,
    id: modelId,
    name: entry?.name ?? (isCatalogModel ? template.name : modelId),
    provider: provider.provider,
    baseUrl: provider.baseUrl || template.baseUrl,
    input: [...input],
    output: [...output],
    ...(!isCatalogModel && { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
  }
}

/** Copilot token format: `tid=...;exp=...;proxy-ep=proxy.individual.githubcopilot.com;...` */
function copilotBaseUrlFromToken(token: string): string | undefined {
  const proxyHost = token.match(/proxy-ep=([^;]+)/)?.[1]
  return proxyHost ? `https://${proxyHost.replace(/^proxy\./, 'api.')}` : undefined
}

export function buildModel(provider: ProviderConfig, modelId?: string): Model<Api> {
  const id = modelId ?? getProviderDefaultModel(provider)
  const preset = PROVIDER_TYPE_PRESETS[provider.providerType]

  // Look up the model from pi-ai to get the correct per-model api type and
  // metadata. This path covers OAuth providers as well as api-key gateways
  // (OpenCode Zen/Go) whose catalog spans multiple wire APIs under one entry.
  if (preset?.piAiProvider && (preset.authMethod === 'oauth' || preset.resolveModelsFromCatalog)) {
    try {
      const piAiModels = getPiCatalogModels(preset.piAiProvider)

      // GitHub Copilot routes each account through its own proxy endpoint,
      // encoded in the access token; the catalog only carries the default one.
      let models: Model<Api>[] = piAiModels as Model<Api>[]
      if (preset.oauthProviderId === 'github-copilot' && provider.oauthCredentials) {
        const baseUrl = copilotBaseUrlFromToken(
          storedToOAuthCredentials(provider.oauthCredentials).access,
        )
        if (baseUrl) models = models.map(m => ({ ...m, baseUrl }))
      }

      const catalogEntry = models.find(m => m.id === id)
      const costOverride = provider.models?.find(m => m.id === id)?.cost
      const piModel = catalogEntry && costOverride
        ? { ...catalogEntry, cost: { ...catalogEntry.cost, ...Object.fromEntries(Object.entries(costOverride).filter(([, v]) => v !== undefined)) } }
        : catalogEntry
      if (piModel) {
        // For Anthropic OAuth, inject the Claude Code CLI user-agent header
        if (provider.providerType === 'anthropic-oauth') {
          return {
            ...piModel,
            headers: {
              ...piModel.headers,
              'user-agent': `claude-cli/${CLAUDE_CODE_VERSION}`,
            },
          }
        }
        return piModel
      }
    } catch {
      // Fall through to generic build
    }
  }

  // Generic build for API key providers or fallback. Each field resolves
  // independently: provider.models (user override) → local
  // PROVIDER_TYPE_MODEL_OVERRIDES → configured price table (cost only) →
  // pi catalog → defaults.
  const modelConfig = resolveModelConfig(provider, id)
  const catalogModel = findPiAiCatalogModel(provider.providerType, id)

  if (isRadiusProviderType(provider.providerType)) {
    const radiusModel = buildRadiusModel(provider, id, modelConfig)
    if (radiusModel) return radiusModel
  }
  const configuredPrice = getConfiguredPriceTable()[id]

  // For Anthropic providers, set the user-agent header to advertise as Claude Code CLI
  const isAnthropicProvider = provider.providerType === 'anthropic' || provider.providerType === 'anthropic-oauth'
  const headers = isAnthropicProvider ? { 'user-agent': `claude-cli/${CLAUDE_CODE_VERSION}` } : undefined
  const thinkingLevelMap = modelConfig?.thinkingLevelMap ?? catalogModel?.thinkingLevelMap

  return {
    id,
    name: modelConfig?.name ?? catalogModel?.name ?? id,
    api: provider.type as Api,
    provider: provider.provider,
    baseUrl: provider.baseUrl,
    reasoning: modelConfig?.reasoning ?? catalogModel?.reasoning ?? false,
    ...(thinkingLevelMap && { thinkingLevelMap }),
    input: [...(modelConfig?.input?.length ? modelConfig.input : catalogModel?.input ?? ['text', 'image'])],
    cost: {
      input: modelConfig?.cost?.input ?? configuredPrice?.input ?? catalogModel?.cost.input ?? 0,
      output: modelConfig?.cost?.output ?? configuredPrice?.output ?? catalogModel?.cost.output ?? 0,
      cacheRead: modelConfig?.cost?.cacheRead ?? catalogModel?.cost.cacheRead ?? 0,
      cacheWrite: modelConfig?.cost?.cacheWrite ?? catalogModel?.cost.cacheWrite ?? 0,
    },
    contextWindow: modelConfig?.contextWindow ?? catalogModel?.contextWindow ?? 128000,
    maxTokens: modelConfig?.maxTokens ?? catalogModel?.maxTokens ?? 16384,
    ...(headers && { headers }),
    ...(provider.compat && { compat: provider.compat }),
  }
}

/**
 * Radius models are only known through the fetched gateway catalog, which
 * carries the wire-level details (thinking level map, max tokens, per-model
 * base URL) that the generic build cannot guess. User edits in
 * `provider.models` win for display name, context window and pricing.
 */
function buildRadiusModel(
  provider: ProviderConfig,
  id: string,
  modelConfig: ProviderModelConfig | undefined,
): Model<Api> | undefined {
  const catalogModel = findRadiusCatalogModel(id)
  if (!catalogModel) return undefined
  return {
    id,
    name: modelConfig?.name ?? catalogModel.name,
    api: 'pi-messages',
    provider: provider.provider,
    baseUrl: catalogModel.baseUrl,
    reasoning: catalogModel.reasoning,
    ...(catalogModel.thinkingLevelMap && { thinkingLevelMap: catalogModel.thinkingLevelMap }),
    input: catalogModel.input,
    cost: {
      input: modelConfig?.cost?.input ?? catalogModel.cost.input,
      output: modelConfig?.cost?.output ?? catalogModel.cost.output,
      cacheRead: modelConfig?.cost?.cacheRead ?? catalogModel.cost.cacheRead,
      cacheWrite: modelConfig?.cost?.cacheWrite ?? catalogModel.cost.cacheWrite,
    },
    contextWindow: modelConfig?.contextWindow ?? catalogModel.contextWindow,
    maxTokens: catalogModel.maxTokens,
  }
}

/**
 * Parse a composite provider:model ID string into its parts.
 * Supports formats:
 *   - "providerId:modelId" → { providerId, modelId }
 *   - "providerId"         → { providerId, modelId: undefined }
 *   - "" / undefined        → { providerId: '', modelId: undefined }
 *
 * When modelId is undefined, callers should fall back to the provider's default model (the first enabled model).
 */
export function parseProviderModelId(value?: string): { providerId: string; modelId?: string } {
  if (!value) return { providerId: '' }
  const colonIdx = value.indexOf(':')
  if (colonIdx === -1) return { providerId: value }
  return {
    providerId: value.slice(0, colonIdx),
    modelId: value.slice(colonIdx + 1) || undefined,
  }
}

/**
 * Resolve a composite provider:model ID to a provider config and model.
 * Returns null if the provider is not found.
 */
export function resolveProviderModelId(value?: string): {
  provider: ProviderConfig
  modelId?: string
} | null {
  const { providerId, modelId } = parseProviderModelId(value)
  if (!providerId) return null
  const file = loadProvidersDecrypted()
  const provider = file.providers.find(p => p.id === providerId)
  if (!provider) return null
  return { provider, modelId }
}

/**
 * Resolve a user-friendly `(provider, model)` pair into a concrete provider
 * and model id. Used by agent tools like `create_cronjob`, `edit_cronjob`,
 * and `create_task` where the user may specify any combination of:
 *
 *   - both provider + model   → validate the model is enabled for that provider
 *   - provider only           → use the provider's default model
 *   - model only              → search providers for one whose enabledModels
 *                               contains the model; unique match wins
 *   - neither                 → `{ ok: false, error: 'none-specified' }`
 *
 * Provider lookup is case-insensitive on both `id` and `name`, matching the
 * pattern used by `resolveProvider` in runtime-composition.
 */
export function resolveProviderModelInput(input: {
  provider?: string | null
  model?: string | null
}): { ok: true; providerId: string; providerName: string; modelId: string; composite: string } | { ok: false; error: string } {
  const providerKey = input.provider?.trim() || ''
  const modelKey = input.model?.trim() || ''

  if (!providerKey && !modelKey) {
    return { ok: false, error: 'No provider or model specified.' }
  }

  const providers = loadProvidersDecrypted().providers.filter(p => getUsableModels(p).length > 0)

  // Case 1 & 2: provider (with or without model) given
  if (providerKey) {
    const match = providers.find(
      p => p.id === providerKey || p.name.toLowerCase() === providerKey.toLowerCase(),
    )
    if (!match) {
      return { ok: false, error: `Provider "${providerKey}" not found. Available providers: ${providers.map(p => p.name).join(', ') || '(none)'}.` }
    }

    const enabledModels = getUsableModels(match)

    let modelId: string
    if (modelKey) {
      const modelMatch = enabledModels.find(m => m.toLowerCase() === modelKey.toLowerCase())
      if (!modelMatch) {
        return { ok: false, error: `Model "${modelKey}" is not enabled for provider "${match.name}". Enabled models: ${enabledModels.join(', ')}.` }
      }
      modelId = modelMatch
    } else {
      modelId = getProviderDefaultModel(match)
    }

    return { ok: true, providerId: match.id, providerName: match.name, modelId, composite: `${match.id}:${modelId}` }
  }

  // Case 3: model only — search all providers for any enabled model that matches
  const hits: Array<{ provider: ProviderConfig; modelId: string }> = []
  for (const p of providers) {
    const enabledModels = getUsableModels(p)
    const modelMatch = enabledModels.find(m => m.toLowerCase() === modelKey.toLowerCase())
    if (modelMatch) hits.push({ provider: p, modelId: modelMatch })
  }

  if (hits.length === 0) {
    return { ok: false, error: `Model "${modelKey}" not found in any configured provider. Configured providers: ${providers.map(p => `${p.name} (${getUsableModels(p).join(', ')})`).join('; ') || '(none)'}.` }
  }
  if (hits.length > 1) {
    return { ok: false, error: `Model "${modelKey}" is ambiguous — enabled in multiple providers: ${hits.map(h => h.provider.name).join(', ')}. Specify the provider explicitly.` }
  }

  const { provider: match, modelId } = hits[0]!
  return { ok: true, providerId: match.id, providerName: match.name, modelId, composite: `${match.id}:${modelId}` }
}

/**
 * Estimate cost from token counts using price table or model cost data
 */
export function estimateCost(
  model: Model<Api>,
  promptTokens: number,
  completionTokens: number,
  cacheReadTokens: number = 0,
  cacheWriteTokens: number = 0,
): number {
  // Model cost is per million tokens
  const inputCost = (promptTokens / 1_000_000) * model.cost.input
  const outputCost = (completionTokens / 1_000_000) * model.cost.output
  const cacheReadCost = (cacheReadTokens / 1_000_000) * model.cost.cacheRead
  const cacheWriteCost = (cacheWriteTokens / 1_000_000) * model.cost.cacheWrite
  return inputCost + outputCost + cacheReadCost + cacheWriteCost
}
