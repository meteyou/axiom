import {
  buildModel,
  extractAndStoreFacts,
  getActiveProvider,
  getApiKeyForProvider,
  loadConfig,
  loadProvidersDecrypted,
} from '@openagent/core'
import type { Database, ProviderConfig } from '@openagent/core'

export interface FactExtractionSettings {
  enabled: boolean
  providerId: string
  minSessionMessages: number
}

export interface SessionHistoryProvider {
  getSessionManager(): {
    buildConversationHistory(
      sessionId: string,
      options?: { userId?: string; startedAt?: number; endAt?: number },
    ): string | null
  }
}

interface SessionRow {
  user_id: number | null
  session_user: string | null
  started_at: string
  ended_at: string | null
  message_count: number
}

interface FactExtractionDeps {
  loadSettings: () => { factExtraction?: Partial<FactExtractionSettings> }
  loadProvidersDecrypted: typeof loadProvidersDecrypted
  getActiveProvider: typeof getActiveProvider
  buildModel: typeof buildModel
  getApiKeyForProvider: typeof getApiKeyForProvider
  extractAndStoreFacts: typeof extractAndStoreFacts
  console: Pick<typeof console, 'log' | 'warn' | 'error'>
}

interface TriggerFactExtractionOptions {
  db: Database
  agentCore: SessionHistoryProvider | null
  userId: string
  sessionId: string
  deps?: Partial<FactExtractionDeps>
}

const DEFAULT_FACT_EXTRACTION_SETTINGS: FactExtractionSettings = {
  enabled: false,
  providerId: '',
  minSessionMessages: 3,
}

const defaultDeps: FactExtractionDeps = {
  loadSettings: () => loadConfig<{ factExtraction?: Partial<FactExtractionSettings> }>('settings.json'),
  loadProvidersDecrypted,
  getActiveProvider,
  buildModel,
  getApiKeyForProvider,
  extractAndStoreFacts,
  console,
}

function parseSqliteTimestamp(value: string | null): number | null {
  if (!value) return null
  const parsed = Date.parse(value.replace(' ', 'T') + 'Z')
  return Number.isFinite(parsed) ? parsed : null
}

function parseStrictNumericUserId(value: string | null | undefined): number | null {
  if (!value) return null
  const trimmed = value.trim()
  if (!/^\d+$/.test(trimmed)) return null

  const numericUserId = Number.parseInt(trimmed, 10)
  return Number.isSafeInteger(numericUserId) ? numericUserId : null
}

function getFactExtractionSettings(
  loadSettings: typeof defaultDeps.loadSettings,
): FactExtractionSettings {
  try {
    return {
      ...DEFAULT_FACT_EXTRACTION_SETTINGS,
      ...(loadSettings().factExtraction ?? {}),
    }
  } catch {
    return { ...DEFAULT_FACT_EXTRACTION_SETTINGS }
  }
}

export async function resolveFactExtractionExecutionContext(
  settings: FactExtractionSettings,
  deps: Partial<FactExtractionDeps> = {},
): Promise<{ provider: ProviderConfig; model: ReturnType<typeof buildModel>; apiKey: string } | null> {
  const resolvedDeps = { ...defaultDeps, ...deps }
  let provider: ProviderConfig | null = null

  if (settings.providerId) {
    const providers = resolvedDeps.loadProvidersDecrypted()
    provider = providers.providers.find(candidate => candidate.id === settings.providerId) ?? null

    if (!provider) {
      resolvedDeps.console.warn(
        `[fact-extraction] Configured provider '${settings.providerId}' not found, using active provider`,
      )
    }
  }

  provider = provider ?? resolvedDeps.getActiveProvider()
  if (!provider) return null

  return {
    provider,
    model: resolvedDeps.buildModel(provider),
    apiKey: await resolvedDeps.getApiKeyForProvider(provider),
  }
}

export function triggerFactExtractionForSessionEnd(options: TriggerFactExtractionOptions): boolean {
  const { db, agentCore, userId, sessionId } = options
  const deps = { ...defaultDeps, ...(options.deps ?? {}) }
  const settings = getFactExtractionSettings(deps.loadSettings)

  if (!agentCore || !settings.enabled) {
    return false
  }

  const sessionRow = db.prepare(
    'SELECT user_id, session_user, started_at, ended_at, message_count FROM sessions WHERE id = ?'
  ).get(sessionId) as SessionRow | undefined

  if (!sessionRow || sessionRow.message_count < settings.minSessionMessages) {
    return false
  }

  const numericUserId = sessionRow.user_id
    ?? parseStrictNumericUserId(sessionRow.session_user)
    ?? parseStrictNumericUserId(userId)
  if (numericUserId === null) {
    deps.console.warn(`[fact-extraction] Skipping session ${sessionId}: no numeric user ID available`)
    return false
  }

  const startedAt = parseSqliteTimestamp(sessionRow.started_at) ?? Date.now()
  const endAt = parseSqliteTimestamp(sessionRow.ended_at) ?? Date.now()
  const conversationHistory = agentCore.getSessionManager().buildConversationHistory(sessionId, {
    userId: String(numericUserId),
    startedAt,
    endAt,
  })

  if (!conversationHistory) {
    return false
  }

  void (async () => {
    try {
      const executionContext = await resolveFactExtractionExecutionContext(settings, deps)
      if (!executionContext) {
        deps.console.warn(`[fact-extraction] No provider available for session ${sessionId}`)
        return
      }

      const result = await deps.extractAndStoreFacts(
        db,
        numericUserId,
        sessionId,
        conversationHistory,
        executionContext.model,
        executionContext.apiKey,
      )

      deps.console.log(`[fact-extraction] Session ${sessionId}: ${result.stored} new facts`)
    } catch (err) {
      deps.console.error(`[fact-extraction] Failed for session ${sessionId}:`, err)
    }
  })()

  return true
}
