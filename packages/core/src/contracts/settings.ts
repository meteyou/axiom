export const HEALTH_MONITOR_FALLBACK_TRIGGERS = ['down', 'degraded'] as const
export type HealthMonitorFallbackTrigger = (typeof HEALTH_MONITOR_FALLBACK_TRIGGERS)[number]

export const TASK_TELEGRAM_DELIVERY_VALUES = ['auto', 'always'] as const
export type TaskTelegramDelivery = (typeof TASK_TELEGRAM_DELIVERY_VALUES)[number]

export const TASK_LOOP_DETECTION_METHODS = ['systematic', 'smart', 'auto'] as const
export type TaskLoopDetectionMethod = (typeof TASK_LOOP_DETECTION_METHODS)[number]

export const SETTINGS_TTS_RESPONSE_FORMATS = ['mp3', 'wav', 'opus', 'flac'] as const
export type TtsResponseFormat = (typeof SETTINGS_TTS_RESPONSE_FORMATS)[number]

/**
 * TTS formats a provider type can actually return. OpenRouter's `/audio/speech`
 * only produces MP3 (or headerless PCM) for every model it routes to; xAI only
 * MP3 and WAV. Unlisted provider types accept every format.
 */
const TTS_RESPONSE_FORMATS_BY_PROVIDER_TYPE: Record<string, readonly TtsResponseFormat[]> = {
  openrouter: ['mp3'],
  xai: ['mp3', 'wav'],
}

export function getSupportedTtsResponseFormats(providerType: string | undefined): readonly TtsResponseFormat[] {
  return (providerType && TTS_RESPONSE_FORMATS_BY_PROVIDER_TYPE[providerType]) || SETTINGS_TTS_RESPONSE_FORMATS
}

/** `requested` when the provider type supports it, otherwise its first supported format. */
export function resolveTtsResponseFormat(providerType: string | undefined, requested: TtsResponseFormat): TtsResponseFormat {
  const supported = getSupportedTtsResponseFormats(providerType)
  return supported.includes(requested) ? requested : supported[0]!
}

/**
 * Thinking / reasoning level for the agent.
 * - `off`: no reasoning (fastest, cheapest, default)
 * - `minimal` → `max`: progressively more reasoning effort
 *
 * pi-ai clamps a level the model does not support to the nearest supported one
 * (see `clampThinkingLevel` in contracts/providers).
 */
export const SETTINGS_APP_LOGOS = ['prism', 'raccoon', 'robot'] as const
export type AppLogo = (typeof SETTINGS_APP_LOGOS)[number]

export const SETTINGS_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type SettingsThinkingLevel = (typeof SETTINGS_THINKING_LEVELS)[number]

export interface HealthMonitorNotificationTogglesContract {
  healthyToDegraded: boolean
  degradedToHealthy: boolean
  degradedToDown: boolean
  healthyToDown: boolean
  downToFallback: boolean
  fallbackToHealthy: boolean
}

export interface HealthMonitorSettingsContract {
  enabled: boolean
  fallbackTrigger: HealthMonitorFallbackTrigger
  failuresBeforeFallback: number
  recoveryCheckIntervalMinutes: number
  successesBeforeRecovery: number
  notifications: HealthMonitorNotificationTogglesContract
}

export interface MemoryConsolidationSettingsContract {
  enabled: boolean
  runAtHour: number
  lookbackDays: number
  providerId: string
  snapshotRetention: number
}

export interface FactExtractionSettingsContract {
  enabled: boolean
  providerId: string
  minSessionMessages: number
}

export interface UploadsSettingsContract {
  /**
   * How many days uploaded files in `/data/uploads/` are kept before the cleanup job
   * removes them. `0` means files are deleted on the next cleanup run.
   */
  retentionDays: number
}

/**
 * Provider-stall watchdog thresholds. Read by the turn runner at turn start,
 * so edits apply to the next turn without a backend restart.
 */
export interface WatchdogSettingsContract {
  stallWarnMs: number
  stallAbortMs: number
}

/** Auto-retry policy for turns that failed with a retryable provider error. */
export interface RetrySettingsContract {
  enabled: boolean
  maxRetries: number
  baseDelayMs: number
}

export interface CompactionTasksSettingsContract {
  enabled: boolean
}

/**
 * Automatic context compaction switches. The token budgets are derived from
 * the model's context window; `settings.json` may tune them via
 * `compaction.reserveTokens` / `compaction.keepRecentTokens`, which are not
 * part of the settings API.
 */
export interface CompactionSettingsContract {
  enabled: boolean
  tasks: CompactionTasksSettingsContract
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettingsContract = {
  enabled: true,
  tasks: {
    enabled: true,
  },
}

export const DEFAULT_WATCHDOG_SETTINGS: WatchdogSettingsContract = {
  stallWarnMs: 30_000,
  stallAbortMs: 90_000,
}

export const DEFAULT_RETRY_SETTINGS: RetrySettingsContract = {
  enabled: true,
  maxRetries: 3,
  baseDelayMs: 2_000,
}

export interface AgentHeartbeatNightModeContract {
  enabled: boolean
  startHour: number
  endHour: number
}

export interface AgentHeartbeatSettingsContract {
  enabled: boolean
  intervalMinutes: number
  nightMode: AgentHeartbeatNightModeContract
}

export interface TasksLoopDetectionSettingsContract {
  enabled: boolean
  method: TaskLoopDetectionMethod
  maxConsecutiveFailures: number
  smartProvider: string
  smartCheckInterval: number
}

export interface TasksStatusUpdatesSettingsContract {
  enabled: boolean
  intervalMinutes: number
}

export interface TasksSettingsContract {
  defaultProvider: string
  maxDurationMinutes: number
  telegramDelivery: TaskTelegramDelivery
  loopDetection: TasksLoopDetectionSettingsContract
  /**
   * Periodic `<task_status type="periodic_update">` signals from the task
   * runner back to the user's parent chat while a background task is
   * running. Disabled by default — enable it to get a visible heartbeat
   * (duration, tool-call count, token estimate) that is delivered via the
   * chat event bus and (optionally) Telegram without invoking the LLM.
   */
  statusUpdates: TasksStatusUpdatesSettingsContract
  /**
   * Thinking level used for background task agents, the task runner's loop
   * detection calls, and internal background jobs (fact extraction, memory
   * consolidation, session summaries). Defaults to `off`.
   */
  backgroundThinkingLevel: SettingsThinkingLevel
}

/**
 * Experimental `codemode` switches. Both default `false` so existing
 * installations keep their current behavior after an update. Enabling one
 * adds the `codemode` tool to the respective agent so it can batch, chain and
 * filter tool calls in a single sandboxed script.
 */
export interface CodemodeSettingsContract {
  /** Add `codemode` to the interactive chat agent (applies from the next turn). */
  mainAgent: boolean
  /** Add `codemode` to background task agents (applies to tasks started after the change). */
  tasks: boolean
}

export interface AppearanceSettingsContract {
  /** Logo shown in the web UI (sidebar, login page, chat avatar, favicon). */
  logo: AppLogo
}

export const IMAGE_GENERATION_MAX_VARIANTS_BOUNDS = { min: 1, max: 10 } as const

export interface ImageGenerationSettingsContract {
  /** Master switch for `image_generate`; enabled image models are still required. */
  enabled: boolean
  /** Default model of `image_generate` as `providerId:modelId`; empty selects the first enabled image model. */
  defaultModel: string
  /** Upper bound of the tool's `n` parameter. */
  maxVariants: number
  /** Workspace-relative folder; images land in a `YYYY-MM-DD/` subfolder of it. */
  outputDir: string
}

/**
 * Normalizes a workspace-relative output folder to `a/b` form. Returns `null`
 * for absolute paths, paths that leave the workspace and the workspace root.
 */
export function normalizeImageOutputDir(value: string): string | null {
  const trimmed = value.trim()
  if (/^([/\\]|[A-Za-z]:)/.test(trimmed)) return null
  const segments: string[] = []
  for (const segment of trimmed.split(/[/\\]+/)) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (segments.length === 0) return null
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  return segments.length > 0 ? segments.join('/') : null
}

export interface TtsSettingsContract {
  enabled: boolean
  /** `providerId:modelId` of a configured TTS model, empty when none is selected. */
  model: string
  /** Provider-specific voice id; empty uses the model's default voice. */
  voice: string
  /** Delivery instructions for models that accept them (e.g. gpt-4o-mini-tts). */
  instructions: string
  responseFormat: TtsResponseFormat
  /** Offer the `send_voice_message` tool to the chat agent. */
  agentTool: boolean
}

export interface SttRewriteSettingsContract {
  enabled: boolean
  providerId: string
}

export interface SttSettingsContract {
  enabled: boolean
  /** `providerId:modelId` of a configured STT model, empty when none is selected. */
  model: string
  /** ISO-639-1 language override; empty follows the user's chat language. */
  language: string
  rewrite: SttRewriteSettingsContract
  /** Offer the `transcribe_audio` tool to the chat and task agents. */
  agentTool: boolean
}

/**
 * Telegram bot settings exposed via the Settings API.
 *
 * On disk these fields live in `/data/config/telegram.json`, not in
 * `settings.json`. The API still nests them under a `telegram` object so the
 * shape mirrors other namespaced groups (`tasks`, `agentHeartbeat`, ...).
 */
export interface TelegramSettingsContract {
  enabled: boolean
  botToken: string
  /** Input batching delay in ms. `0` disables batching. */
  batchingDelayMs: number
  sendVoiceReply: boolean
  /**
   * Deliver provider-stall warnings to Telegram. Off by default so transient
   * hiccups don't spam the chat; terminal errors are always delivered.
   */
  sendStallWarnings: boolean
}

export interface SettingsContract {
  sessionTimeoutMinutes: number
  sessionSummaryProviderId: string
  language: string
  timezone: string
  /**
   * Thinking level used for the main chat agent (web + telegram).
   * Defaults to `off` so existing installations keep zero-cost behavior.
   */
  thinkingLevel: SettingsThinkingLevel
  healthMonitorIntervalMinutes: number
  uploads: UploadsSettingsContract
  watchdog: WatchdogSettingsContract
  retry: RetrySettingsContract
  compaction: CompactionSettingsContract
  telegram: TelegramSettingsContract
  healthMonitor: HealthMonitorSettingsContract
  memoryConsolidation: MemoryConsolidationSettingsContract
  factExtraction: FactExtractionSettingsContract
  agentHeartbeat: AgentHeartbeatSettingsContract
  tasks: TasksSettingsContract
  codemode: CodemodeSettingsContract
  imageGeneration: ImageGenerationSettingsContract
  tts: TtsSettingsContract
  stt: SttSettingsContract
  appearance: AppearanceSettingsContract
}

export type SettingsUpdateContract = DeepPartial<SettingsContract>

export interface SettingsStorageContract {
  sessionTimeoutMinutes?: number
  sessionSummaryProviderId?: string
  language?: string
  timezone?: string
  thinkingLevel?: SettingsThinkingLevel
  healthMonitorIntervalMinutes?: number
  healthMonitor?: Partial<HealthMonitorSettingsContract> & { intervalMinutes?: number }
  uploads?: Partial<UploadsSettingsContract>
  watchdog?: Partial<WatchdogSettingsContract>
  retry?: Partial<RetrySettingsContract>
  compaction?: Partial<Omit<CompactionSettingsContract, 'tasks'>> & {
    tasks?: Partial<CompactionTasksSettingsContract>
    /** File-only tuning: tokens kept free for the answer (default 16384, capped at 25% of the window). */
    reserveTokens?: number
    /** File-only tuning: recent tokens kept verbatim (default 20000, capped at 30% of the trigger). */
    keepRecentTokens?: number
  }
  memoryConsolidation?: Partial<MemoryConsolidationSettingsContract>
  factExtraction?: Partial<FactExtractionSettingsContract>
  agentHeartbeat?: Partial<AgentHeartbeatSettingsContract>
  tasks?: Partial<TasksSettingsContract>
  codemode?: Partial<CodemodeSettingsContract>
  imageGeneration?: Partial<ImageGenerationSettingsContract>
  tts?: Partial<TtsSettingsContract>
  stt?: Partial<SttSettingsContract>
  appearance?: Partial<AppearanceSettingsContract>
}

export interface TelegramSettingsStorageContract {
  enabled?: boolean
  botToken?: string
  adminUserIds?: number[]
  pollingMode?: boolean
  webhookUrl?: string
  batchingDelayMs?: number
  sendVoiceReply?: boolean
  sendStallWarnings?: boolean
}

export type HealthMonitorSettingsUpdateContract = DeepPartial<HealthMonitorSettingsContract> & {
  intervalMinutes?: number
}

export type LegacyCompatibleSettingsUpdateContract = SettingsUpdateContract & {
  healthMonitor?: HealthMonitorSettingsUpdateContract
}

export const DEFAULT_HEALTH_MONITOR_NOTIFICATION_TOGGLES: HealthMonitorNotificationTogglesContract = {
  healthyToDegraded: false,
  degradedToHealthy: false,
  degradedToDown: true,
  healthyToDown: true,
  downToFallback: true,
  fallbackToHealthy: true,
}

export const DEFAULT_SETTINGS_CONTRACT: SettingsContract = {
  sessionTimeoutMinutes: 30,
  sessionSummaryProviderId: '',
  language: 'match',
  timezone: 'UTC',
  thinkingLevel: 'off',
  healthMonitorIntervalMinutes: 5,
  uploads: {
    retentionDays: 30,
  },
  watchdog: { ...DEFAULT_WATCHDOG_SETTINGS },
  retry: { ...DEFAULT_RETRY_SETTINGS },
  compaction: { ...DEFAULT_COMPACTION_SETTINGS, tasks: { ...DEFAULT_COMPACTION_SETTINGS.tasks } },
  telegram: {
    enabled: false,
    botToken: '',
    batchingDelayMs: 2500,
    sendVoiceReply: false,
    sendStallWarnings: false,
  },
  healthMonitor: {
    enabled: true,
    fallbackTrigger: 'down',
    failuresBeforeFallback: 1,
    recoveryCheckIntervalMinutes: 1,
    successesBeforeRecovery: 3,
    notifications: { ...DEFAULT_HEALTH_MONITOR_NOTIFICATION_TOGGLES },
  },
  memoryConsolidation: {
    enabled: true,
    runAtHour: 3,
    lookbackDays: 3,
    providerId: '',
    snapshotRetention: 7,
  },
  factExtraction: {
    enabled: true,
    providerId: '',
    minSessionMessages: 3,
  },
  agentHeartbeat: {
    enabled: false,
    intervalMinutes: 60,
    nightMode: {
      enabled: true,
      startHour: 23,
      endHour: 8,
    },
  },
  tasks: {
    defaultProvider: '',
    maxDurationMinutes: 60,
    telegramDelivery: 'auto',
    loopDetection: {
      enabled: true,
      method: 'systematic',
      maxConsecutiveFailures: 3,
      smartProvider: '',
      smartCheckInterval: 5,
    },
    statusUpdates: {
      enabled: false,
      intervalMinutes: 10,
    },
    backgroundThinkingLevel: 'off',
  },
  codemode: {
    mainAgent: false,
    tasks: false,
  },
  imageGeneration: {
    enabled: true,
    defaultModel: '',
    maxVariants: 4,
    outputDir: 'images',
  },
  tts: {
    enabled: false,
    model: '',
    voice: '',
    instructions: '',
    responseFormat: 'mp3',
    agentTool: false,
  },
  stt: {
    enabled: false,
    model: '',
    language: '',
    rewrite: {
      enabled: false,
      providerId: '',
    },
    agentTool: false,
  },
  appearance: {
    logo: 'prism',
  },
}

function normalizeThinkingLevel(
  value: SettingsThinkingLevel | undefined,
  fallback: SettingsThinkingLevel,
): SettingsThinkingLevel {
  if (value && (SETTINGS_THINKING_LEVELS as readonly string[]).includes(value)) {
    return value
  }
  return fallback
}

/**
 * Normalize `tasks.statusUpdates` with migration from the legacy flat
 * `tasks.statusUpdateIntervalMinutes` field. When only the legacy value is
 * present, it is carried over as the interval; `enabled` stays `false` so
 * existing installations don't suddenly start emitting status-update chat
 * messages after upgrading. Setups that had explicitly set the legacy value
 * to a custom interval keep that interval — only the explicit opt-in is
 * new.
 */
function normalizeTasksStatusUpdates(
  source: DeepPartial<TasksSettingsContract> | undefined,
): TasksStatusUpdatesSettingsContract {
  const fallback = DEFAULT_SETTINGS_CONTRACT.tasks.statusUpdates
  const statusUpdates = source?.statusUpdates
  const legacyInterval = (source as { statusUpdateIntervalMinutes?: number } | undefined)?.statusUpdateIntervalMinutes
  const validLegacyInterval = typeof legacyInterval === 'number' && legacyInterval > 0 ? legacyInterval : undefined
  if (statusUpdates && (statusUpdates.enabled !== undefined || statusUpdates.intervalMinutes !== undefined)) {
    return {
      enabled: statusUpdates.enabled ?? fallback.enabled,
      intervalMinutes: statusUpdates.intervalMinutes ?? validLegacyInterval ?? fallback.intervalMinutes,
    }
  }
  if (validLegacyInterval !== undefined) {
    return {
      enabled: fallback.enabled,
      intervalMinutes: validLegacyInterval,
    }
  }
  return { ...fallback }
}

/** Tolerates hand-edited `settings.json`: invalid values fall back to their defaults. */
export function normalizeImageGenerationSettings(
  source: DeepPartial<ImageGenerationSettingsContract> | null | undefined,
): ImageGenerationSettingsContract {
  const defaults = DEFAULT_SETTINGS_CONTRACT.imageGeneration
  const { min, max } = IMAGE_GENERATION_MAX_VARIANTS_BOUNDS
  const maxVariants = source?.maxVariants
  return {
    enabled: source?.enabled !== false,
    defaultModel: typeof source?.defaultModel === 'string' ? source.defaultModel.trim() : defaults.defaultModel,
    maxVariants: typeof maxVariants === 'number' && Number.isInteger(maxVariants) && maxVariants >= min && maxVariants <= max
      ? maxVariants
      : defaults.maxVariants,
    outputDir: (typeof source?.outputDir === 'string' && normalizeImageOutputDir(source.outputDir)) || defaults.outputDir,
  }
}

export function normalizeCompactionSettings(
  source: DeepPartial<CompactionSettingsContract> | undefined,
): CompactionSettingsContract {
  const fallback = DEFAULT_COMPACTION_SETTINGS
  return {
    enabled: source?.enabled ?? fallback.enabled,
    tasks: {
      enabled: source?.tasks?.enabled ?? fallback.tasks.enabled,
    },
  }
}

export function normalizeAppLogo(value: unknown): AppLogo {
  return (SETTINGS_APP_LOGOS as readonly unknown[]).includes(value)
    ? value as AppLogo
    : DEFAULT_SETTINGS_CONTRACT.appearance.logo
}

export function normalizeSettingsContract(input: DeepPartial<SettingsContract> | null | undefined): SettingsContract {
  const source = input ?? {}

  return {
    sessionTimeoutMinutes: source.sessionTimeoutMinutes ?? DEFAULT_SETTINGS_CONTRACT.sessionTimeoutMinutes,
    sessionSummaryProviderId: source.sessionSummaryProviderId ?? DEFAULT_SETTINGS_CONTRACT.sessionSummaryProviderId,
    language: source.language ?? DEFAULT_SETTINGS_CONTRACT.language,
    timezone: source.timezone ?? DEFAULT_SETTINGS_CONTRACT.timezone,
    thinkingLevel: normalizeThinkingLevel(source.thinkingLevel, DEFAULT_SETTINGS_CONTRACT.thinkingLevel),
    healthMonitorIntervalMinutes: source.healthMonitorIntervalMinutes ?? DEFAULT_SETTINGS_CONTRACT.healthMonitorIntervalMinutes,
    uploads: {
      retentionDays: source.uploads?.retentionDays ?? DEFAULT_SETTINGS_CONTRACT.uploads.retentionDays,
    },
    watchdog: {
      stallWarnMs: source.watchdog?.stallWarnMs ?? DEFAULT_SETTINGS_CONTRACT.watchdog.stallWarnMs,
      stallAbortMs: source.watchdog?.stallAbortMs ?? DEFAULT_SETTINGS_CONTRACT.watchdog.stallAbortMs,
    },
    retry: {
      enabled: source.retry?.enabled ?? DEFAULT_SETTINGS_CONTRACT.retry.enabled,
      maxRetries: source.retry?.maxRetries ?? DEFAULT_SETTINGS_CONTRACT.retry.maxRetries,
      baseDelayMs: source.retry?.baseDelayMs ?? DEFAULT_SETTINGS_CONTRACT.retry.baseDelayMs,
    },
    compaction: normalizeCompactionSettings(source.compaction),
    telegram: {
      enabled: source.telegram?.enabled ?? DEFAULT_SETTINGS_CONTRACT.telegram.enabled,
      botToken: source.telegram?.botToken ?? DEFAULT_SETTINGS_CONTRACT.telegram.botToken,
      batchingDelayMs: source.telegram?.batchingDelayMs ?? DEFAULT_SETTINGS_CONTRACT.telegram.batchingDelayMs,
      sendVoiceReply: source.telegram?.sendVoiceReply ?? DEFAULT_SETTINGS_CONTRACT.telegram.sendVoiceReply,
      sendStallWarnings: source.telegram?.sendStallWarnings ?? DEFAULT_SETTINGS_CONTRACT.telegram.sendStallWarnings,
    },
    healthMonitor: {
      enabled: source.healthMonitor?.enabled ?? DEFAULT_SETTINGS_CONTRACT.healthMonitor.enabled,
      fallbackTrigger: source.healthMonitor?.fallbackTrigger ?? DEFAULT_SETTINGS_CONTRACT.healthMonitor.fallbackTrigger,
      failuresBeforeFallback:
        source.healthMonitor?.failuresBeforeFallback ?? DEFAULT_SETTINGS_CONTRACT.healthMonitor.failuresBeforeFallback,
      recoveryCheckIntervalMinutes:
        source.healthMonitor?.recoveryCheckIntervalMinutes
        ?? DEFAULT_SETTINGS_CONTRACT.healthMonitor.recoveryCheckIntervalMinutes,
      successesBeforeRecovery:
        source.healthMonitor?.successesBeforeRecovery ?? DEFAULT_SETTINGS_CONTRACT.healthMonitor.successesBeforeRecovery,
      notifications: {
        healthyToDegraded:
          source.healthMonitor?.notifications?.healthyToDegraded
          ?? DEFAULT_SETTINGS_CONTRACT.healthMonitor.notifications.healthyToDegraded,
        degradedToHealthy:
          source.healthMonitor?.notifications?.degradedToHealthy
          ?? DEFAULT_SETTINGS_CONTRACT.healthMonitor.notifications.degradedToHealthy,
        degradedToDown:
          source.healthMonitor?.notifications?.degradedToDown
          ?? DEFAULT_SETTINGS_CONTRACT.healthMonitor.notifications.degradedToDown,
        healthyToDown:
          source.healthMonitor?.notifications?.healthyToDown
          ?? DEFAULT_SETTINGS_CONTRACT.healthMonitor.notifications.healthyToDown,
        downToFallback:
          source.healthMonitor?.notifications?.downToFallback
          ?? DEFAULT_SETTINGS_CONTRACT.healthMonitor.notifications.downToFallback,
        fallbackToHealthy:
          source.healthMonitor?.notifications?.fallbackToHealthy
          ?? DEFAULT_SETTINGS_CONTRACT.healthMonitor.notifications.fallbackToHealthy,
      },
    },
    memoryConsolidation: {
      enabled: source.memoryConsolidation?.enabled ?? DEFAULT_SETTINGS_CONTRACT.memoryConsolidation.enabled,
      runAtHour: source.memoryConsolidation?.runAtHour ?? DEFAULT_SETTINGS_CONTRACT.memoryConsolidation.runAtHour,
      lookbackDays: source.memoryConsolidation?.lookbackDays ?? DEFAULT_SETTINGS_CONTRACT.memoryConsolidation.lookbackDays,
      providerId: source.memoryConsolidation?.providerId ?? DEFAULT_SETTINGS_CONTRACT.memoryConsolidation.providerId,
      snapshotRetention:
        source.memoryConsolidation?.snapshotRetention ?? DEFAULT_SETTINGS_CONTRACT.memoryConsolidation.snapshotRetention,
    },
    factExtraction: {
      enabled: source.factExtraction?.enabled ?? DEFAULT_SETTINGS_CONTRACT.factExtraction.enabled,
      providerId: source.factExtraction?.providerId ?? DEFAULT_SETTINGS_CONTRACT.factExtraction.providerId,
      minSessionMessages:
        source.factExtraction?.minSessionMessages ?? DEFAULT_SETTINGS_CONTRACT.factExtraction.minSessionMessages,
    },
    agentHeartbeat: {
      enabled: source.agentHeartbeat?.enabled ?? DEFAULT_SETTINGS_CONTRACT.agentHeartbeat.enabled,
      intervalMinutes: source.agentHeartbeat?.intervalMinutes ?? DEFAULT_SETTINGS_CONTRACT.agentHeartbeat.intervalMinutes,
      nightMode: {
        enabled: source.agentHeartbeat?.nightMode?.enabled ?? DEFAULT_SETTINGS_CONTRACT.agentHeartbeat.nightMode.enabled,
        startHour:
          source.agentHeartbeat?.nightMode?.startHour ?? DEFAULT_SETTINGS_CONTRACT.agentHeartbeat.nightMode.startHour,
        endHour: source.agentHeartbeat?.nightMode?.endHour ?? DEFAULT_SETTINGS_CONTRACT.agentHeartbeat.nightMode.endHour,
      },
    },
    tasks: {
      defaultProvider: source.tasks?.defaultProvider ?? DEFAULT_SETTINGS_CONTRACT.tasks.defaultProvider,
      maxDurationMinutes: source.tasks?.maxDurationMinutes ?? DEFAULT_SETTINGS_CONTRACT.tasks.maxDurationMinutes,
      telegramDelivery: source.tasks?.telegramDelivery ?? DEFAULT_SETTINGS_CONTRACT.tasks.telegramDelivery,
      loopDetection: {
        enabled: source.tasks?.loopDetection?.enabled ?? DEFAULT_SETTINGS_CONTRACT.tasks.loopDetection.enabled,
        method: source.tasks?.loopDetection?.method ?? DEFAULT_SETTINGS_CONTRACT.tasks.loopDetection.method,
        maxConsecutiveFailures:
          source.tasks?.loopDetection?.maxConsecutiveFailures
          ?? DEFAULT_SETTINGS_CONTRACT.tasks.loopDetection.maxConsecutiveFailures,
        smartProvider:
          source.tasks?.loopDetection?.smartProvider ?? DEFAULT_SETTINGS_CONTRACT.tasks.loopDetection.smartProvider,
        smartCheckInterval:
          source.tasks?.loopDetection?.smartCheckInterval
          ?? DEFAULT_SETTINGS_CONTRACT.tasks.loopDetection.smartCheckInterval,
      },
      statusUpdates: normalizeTasksStatusUpdates(source.tasks),
      backgroundThinkingLevel: normalizeThinkingLevel(
        source.tasks?.backgroundThinkingLevel,
        DEFAULT_SETTINGS_CONTRACT.tasks.backgroundThinkingLevel,
      ),
    },
    codemode: {
      mainAgent: source.codemode?.mainAgent === true,
      tasks: source.codemode?.tasks === true,
    },
    imageGeneration: normalizeImageGenerationSettings(source.imageGeneration),
    tts: normalizeTtsSettings(source.tts),
    stt: normalizeSttSettings(source.stt),
    appearance: {
      logo: normalizeAppLogo(source.appearance?.logo),
    },
  }
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

export function normalizeTtsSettings(source: Partial<TtsSettingsContract> | undefined): TtsSettingsContract {
  const defaults = DEFAULT_SETTINGS_CONTRACT.tts
  const format = source?.responseFormat
  return {
    enabled: source?.enabled === true,
    model: stringOr(source?.model, defaults.model),
    voice: stringOr(source?.voice, defaults.voice),
    instructions: stringOr(source?.instructions, defaults.instructions),
    responseFormat: format && (SETTINGS_TTS_RESPONSE_FORMATS as readonly string[]).includes(format) ? format : defaults.responseFormat,
    agentTool: source?.agentTool === true,
  }
}

export function normalizeSttSettings(
  source: (Partial<Omit<SttSettingsContract, 'rewrite'>> & { rewrite?: Partial<SttRewriteSettingsContract> }) | undefined,
): SttSettingsContract {
  const defaults = DEFAULT_SETTINGS_CONTRACT.stt
  return {
    enabled: source?.enabled === true,
    model: stringOr(source?.model, defaults.model),
    language: stringOr(source?.language, defaults.language),
    rewrite: {
      enabled: source?.rewrite?.enabled === true,
      providerId: stringOr(source?.rewrite?.providerId, defaults.rewrite.providerId),
    },
    agentTool: source?.agentTool === true,
  }
}

export function withLegacySettingsPayloadCompatibility(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (payload.healthMonitorIntervalMinutes !== undefined) {
    return payload
  }

  const healthMonitor = payload.healthMonitor
  if (!healthMonitor || typeof healthMonitor !== 'object') {
    return payload
  }

  const intervalMinutes = (healthMonitor as Record<string, unknown>).intervalMinutes
  if (intervalMinutes === undefined) {
    return payload
  }

  return {
    ...payload,
    healthMonitorIntervalMinutes: intervalMinutes,
  }
}

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object
    ? DeepPartial<T[K]>
    : T[K]
}
