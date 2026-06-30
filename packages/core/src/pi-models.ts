import {
  createModels,
  createProvider,
  envApiKeyAuth,
} from '@earendil-works/pi-ai'
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  MutableModels,
  ProviderStreams,
  SimpleStreamOptions,
} from '@earendil-works/pi-ai'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { googleGenerativeAIApi } from '@earendil-works/pi-ai/api/google-generative-ai.lazy'
import { mistralConversationsApi } from '@earendil-works/pi-ai/api/mistral-conversations.lazy'
import { openAICodexResponsesApi } from '@earendil-works/pi-ai/api/openai-codex-responses.lazy'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'

/**
 * Wire-API implementations Axiom can reach. The set covers every preset
 * `apiType` plus the extra wire APIs an OpenCode gateway can surface under a
 * single provider entry (`openai-responses`, `google-generative-ai`). Each
 * value is a lazy `ProviderStreams` factory, so the underlying API module only
 * loads when a request first dispatches to it.
 */
const API_IMPLEMENTATIONS: Partial<Record<Api, () => ProviderStreams>> = {
  'anthropic-messages': anthropicMessagesApi,
  'openai-completions': openAICompletionsApi,
  'openai-responses': openAIResponsesApi,
  'openai-codex-responses': openAICodexResponsesApi,
  'google-generative-ai': googleGenerativeAIApi,
  'mistral-conversations': mistralConversationsApi,
}

function buildApiMap(): Partial<Record<Api, ProviderStreams>> {
  const map: Partial<Record<Api, ProviderStreams>> = {}
  for (const api of Object.keys(API_IMPLEMENTATIONS) as Api[]) {
    map[api] = API_IMPLEMENTATIONS[api]!()
  }
  return map
}

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
    api: buildApiMap(),
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
