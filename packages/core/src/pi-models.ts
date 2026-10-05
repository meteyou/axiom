import {
  cleanupSessionResources,
  createModels,
  createProvider,
  envApiKeyAuth,
} from '@earendil-works/pi-ai'
import type {
  Api,
  AssistantImages,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  ImageApi,
  ImageModel,
  ImagesContext,
  ImagesOptions,
  Model,
  MutableModels,
  ProviderImages,
  ProviderStreams,
  SimpleStreamOptions,
} from '@earendil-works/pi-ai'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { googleGenerativeAIApi } from '@earendil-works/pi-ai/api/google-generative-ai.lazy'
import { mistralConversationsApi } from '@earendil-works/pi-ai/api/mistral-conversations.lazy'
import { openAICodexResponsesApi } from '@earendil-works/pi-ai/api/openai-codex-responses.lazy'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import { piMessagesApi } from '@earendil-works/pi-ai/api/pi-messages.lazy'
import { OPENAI_CODEX_IMAGES_API, OPENAI_IMAGES_API, openAICodexImagesApi, openAIImagesApi } from './openai-images-api.js'
import { OPENROUTER_IMAGES_API, openRouterImagesApi } from './openrouter-images-api.js'

/**
 * Wire-API implementations Axiom can reach. The set covers every preset
 * `apiType` plus the extra wire APIs an OpenCode gateway can surface under a
 * single provider entry (`openai-responses`, `google-generative-ai`). Each
 * value is a lazy `ProviderStreams` factory, so the underlying API module only
 * loads when a request first dispatches to it.
 */
const API_IMPLEMENTATIONS = {
  'anthropic-messages': anthropicMessagesApi,
  'openai-completions': openAICompletionsApi,
  'openai-responses': openAIResponsesApi,
  'openai-codex-responses': openAICodexResponsesApi,
  'google-generative-ai': googleGenerativeAIApi,
  'mistral-conversations': mistralConversationsApi,
  'pi-messages': piMessagesApi,
} satisfies Partial<Record<Api, () => ProviderStreams>>

/**
 * Wire APIs this module can dispatch to. A model whose `api` is missing fails
 * only at request time (as a stream error), so `pi-models.test.ts` locks this
 * set against every reachable preset/catalog api.
 */
export const SUPPORTED_APIS: ReadonlySet<Api> = new Set(Object.keys(API_IMPLEMENTATIONS) as Api[])

/** Shared across providers: the lazy wrappers are stateless and load on first dispatch. */
const API_MAP: Partial<Record<Api, ProviderStreams>> = Object.fromEntries(
  Object.entries(API_IMPLEMENTATIONS).map(([api, factory]) => [api, factory()]),
)

const IMAGE_API_IMPLEMENTATIONS = {
  [OPENROUTER_IMAGES_API]: openRouterImagesApi,
  [OPENAI_IMAGES_API]: openAIImagesApi,
  [OPENAI_CODEX_IMAGES_API]: openAICodexImagesApi,
} satisfies Partial<Record<ImageApi, () => ProviderImages>>

/** Image APIs this module can dispatch to; image catalog entries on other APIs are not offered. */
export const SUPPORTED_IMAGE_APIS: ReadonlySet<ImageApi> = new Set(Object.keys(IMAGE_API_IMPLEMENTATIONS) as ImageApi[])

const IMAGE_API_MAP: Partial<Record<ImageApi, ProviderImages>> = Object.fromEntries(
  Object.entries(IMAGE_API_IMPLEMENTATIONS).map(([api, factory]) => [api, factory()]),
)

/**
 * Single shared collection reused across every completion/stream call site so
 * provider registration and auth resolution happen once. Axiom resolves its
 * own credentials and passes the API key per request via
 * `SimpleStreamOptions.apiKey`, so this instance carries no credential store.
 */
let modelsInstance: MutableModels | undefined

function getModelsInstance(): MutableModels {
  modelsInstance ??= createModels()
  return modelsInstance
}

/**
 * Register a pure api-dispatching provider for `providerId` the first time it
 * is seen. Axiom builds its own `Model` objects with arbitrary provider ids and
 * base URLs; `Models` routes each request to the provider registered under
 * `model.provider`, so every distinct id needs a provider. Auth is supplied per
 * request through `options.apiKey`, which `Models` forwards verbatim, so the
 * provider's `apiKey` auth only needs to honour the passed key (empty env list).
 */
function ensureProvider(models: MutableModels, providerId: string): void {
  if (models.getProvider(providerId)) return
  models.setProvider(createProvider({
    id: providerId,
    auth: { apiKey: envApiKeyAuth(`${providerId} API key`, []) },
    models: [],
    api: API_MAP,
    images: IMAGE_API_MAP,
  }))
}

/**
 * Drop-in replacement for the former `@earendil-works/pi-ai/compat`
 * `streamSimple` free function, backed by the shared `Models` instance.
 */
export function streamSimple(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const models = getModelsInstance()
  ensureProvider(models, model.provider)
  return models.streamSimple(model, context, options)
}

/**
 * Drop-in replacement for the former `@earendil-works/pi-ai/compat`
 * `completeSimple` free function, backed by the shared `Models` instance.
 */
export function completeSimple(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): Promise<AssistantMessage> {
  const models = getModelsInstance()
  ensureProvider(models, model.provider)
  return models.completeSimple(model, context, options)
}

/**
 * Image generation through the shared `Models` instance. Like the text calls,
 * pi-ai reports provider failures as `stopReason: "error"` instead of throwing.
 */
export function generateImages(
  model: ImageModel<ImageApi>,
  context: ImagesContext,
  options?: ImagesOptions,
): Promise<AssistantImages> {
  const models = getModelsInstance()
  ensureProvider(models, model.provider)
  return models.generateImages(model, context, options)
}

/**
 * Release provider-side resources pooled per session (e.g. Codex WebSockets).
 */
export function releaseProviderSession(sessionId: string | null | undefined): void {
  // pi-ai treats a missing id as "close every session", which would tear down unrelated live turns.
  if (!sessionId) return
  try {
    cleanupSessionResources(sessionId)
  } catch (err) {
    console.error(`[pi-models] Failed to release provider session ${sessionId}:`, err)
  }
}
