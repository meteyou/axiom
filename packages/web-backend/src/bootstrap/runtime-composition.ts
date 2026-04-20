import {
  AgentCore,
  AgentHeartbeatService,
  buildModel,
  createBaseAgentTools,
  createCronjobTool,
  createReminderTool,
  createResumeTaskTool,
  createTaskRuntime,
  createTaskTool,
  loadSttSettings,
  deliverTaskNotification,
  resolveTaskNotificationSessionId,
  editCronjobTool,
  ensureConfigStructure,
  ensureConfigTemplates,
  ensureMemoryStructure,
  getActiveModelId,
  getActiveProvider,
  getApiKeyForProvider,
  getCronjobTool,
  getFallbackModelId,
  getFallbackProvider,
  initDatabase,
  injectSecretsIntoEnv,
  listCronjobsTool,
  listTasksTool,
  loadConfig,
  loadProvidersDecrypted,
  logToolCall,
  parseProviderModelId,
  ProviderManager,
  SessionManager,
  removeCronjobTool,
  TaskEventBus,
} from '@openagent/core'
import type {
  BuiltinToolsConfig,
  Database,
  LoopDetectionConfig,
  ProviderConfig,
  TaskRuntimeBoundary,
  TaskRuntimeTaskBoundary,
} from '@openagent/core'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import { randomUUID } from 'node:crypto'
import { createTelegramBot } from '@openagent/telegram'
import type { TelegramBot, TelegramChatEvent } from '@openagent/telegram'
import { ChatEventBus } from '../chat-event-bus.js'
import { triggerFactExtractionForSessionEnd } from '../fact-extraction-session-end.js'
import { HealthMonitorService } from '../health-monitor.js'
import { MemoryConsolidationScheduler } from '../memory-consolidation-scheduler.js'
import { RuntimeMetrics } from '../runtime-metrics.js'

interface PendingTaskInjectionMeta {
  taskId: string
  userId: number
  /**
   * The interactive session id that will receive the streamed injection
   * response AND the persisted `task_result` chat_messages row. Pre-resolved
   * by `AgentCore.resolveInjectionSessionId` and forced into the injection
   * stream via `injectTaskResult(..., forcedSessionId)` so both the caller's
   * persistence path and the streamed chunks agree on the same session
   * without relying on FIFO ordering.
   */
  sessionId: string
  /**
   * Unique per-injection correlation token. Used as the map key so
   * multiple concurrent task completions targeting the same user's
   * cached session (which share a `sessionId`) do not collide. The same
   * token is threaded through `injectTaskResult(..., injectionId)` and
   * tagged onto every emitted chunk as `chunk.injectionId`.
   */
  injectionId: string
}

interface TaskSettings {
  defaultProvider: string
  maxDurationMinutes: number
  telegramDelivery: string
  loopDetection: {
    enabled: boolean
    method: string
    maxConsecutiveFailures: number
    smartProvider: string
    smartCheckInterval: number
  }
  statusUpdateIntervalMinutes: number
}

interface RuntimeSettings {
  sessionTimeoutMinutes: number
  taskSettings: TaskSettings
  builtinToolsConfig: BuiltinToolsConfig | undefined
}

export interface RuntimeComposition {
  db: Database
  runtimeMetrics: RuntimeMetrics
  healthMonitorService: HealthMonitorService
  consolidationScheduler: MemoryConsolidationScheduler
  agentHeartbeatService: AgentHeartbeatService
  taskEventBus: TaskEventBus
  chatEventBus: ChatEventBus
  getAgentCore: () => AgentCore | null
  getTaskRuntime: () => TaskRuntimeBoundary
  getTelegramBot: () => TelegramBot | null
  onTelegramSettingsChanged: () => void
  onActiveProviderChanged: () => void
  setWebSocketChatPresenceChecker: (checker: { hasActiveWebSocket: (userId: number) => boolean } | null) => void
  stopBackgroundServices: () => Promise<void>
}

export interface RuntimeCompositionOptions {
  logger?: Pick<typeof console, 'log' | 'warn' | 'error'>
}

function loadRuntimeSettings(): RuntimeSettings {
  let sessionTimeoutMinutes = 15
  const taskSettings: TaskSettings = {
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
    statusUpdateIntervalMinutes: 10,
  }

  let builtinToolsConfig: BuiltinToolsConfig | undefined

  try {
    const settings = loadConfig<{
      sessionTimeoutMinutes?: number
      tasks?: Partial<TaskSettings>
      builtinTools?: BuiltinToolsConfig
      braveSearchApiKey?: string
      searxngUrl?: string
    }>('settings.json')

    if (settings.sessionTimeoutMinutes && settings.sessionTimeoutMinutes > 0) {
      sessionTimeoutMinutes = settings.sessionTimeoutMinutes
    }

    if (settings.tasks) {
      taskSettings.defaultProvider = settings.tasks.defaultProvider ?? taskSettings.defaultProvider
      taskSettings.maxDurationMinutes = settings.tasks.maxDurationMinutes ?? taskSettings.maxDurationMinutes
      taskSettings.telegramDelivery = settings.tasks.telegramDelivery ?? taskSettings.telegramDelivery
      taskSettings.statusUpdateIntervalMinutes =
        settings.tasks.statusUpdateIntervalMinutes ?? taskSettings.statusUpdateIntervalMinutes

      if (settings.tasks.loopDetection) {
        taskSettings.loopDetection = {
          ...taskSettings.loopDetection,
          ...settings.tasks.loopDetection,
        }
      }
    }

    builtinToolsConfig = settings.builtinTools

    // Migrate legacy top-level keys into builtinTools.webSearch
    if (settings.braveSearchApiKey && !builtinToolsConfig?.webSearch?.braveSearchApiKey) {
      builtinToolsConfig = builtinToolsConfig ?? {}
      builtinToolsConfig.webSearch = {
        ...builtinToolsConfig.webSearch,
        braveSearchApiKey: settings.braveSearchApiKey,
      }
    }

    if (settings.searxngUrl && !builtinToolsConfig?.webSearch?.searxngUrl) {
      builtinToolsConfig = builtinToolsConfig ?? {}
      builtinToolsConfig.webSearch = {
        ...builtinToolsConfig.webSearch,
        searxngUrl: settings.searxngUrl,
      }
    }
  } catch {
    // use default values
  }

  return {
    sessionTimeoutMinutes,
    taskSettings,
    builtinToolsConfig,
  }
}

function escapeHtmlForTelegram(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function normalizeReminderText(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/^⏰\s*/u, '')
    .replace(/^(reminder|erinnerung)\s*:\s*/u, '')
    .replace(/[.!?]+$/u, '')
    .replace(/\s+/g, ' ')
}

function areReminderFieldsDistinct(name: string, message: string): boolean {
  const normalizedName = normalizeReminderText(name)
  const normalizedMessage = normalizeReminderText(message)

  if (!normalizedName || !normalizedMessage) return normalizedName !== normalizedMessage
  if (normalizedName === normalizedMessage) return false
  if (normalizedMessage.includes(normalizedName) || normalizedName.includes(normalizedMessage)) return false

  return true
}

function formatReminderTelegramHtml(name: string, message: string): string {
  if (!areReminderFieldsDistinct(name, message)) {
    const singleLine = message.trim() || name.trim()
    return `⏰ ${escapeHtmlForTelegram(singleLine)}`
  }

  return `⏰ <b>${escapeHtmlForTelegram(name)}</b>\n\n${escapeHtmlForTelegram(message)}`
}

function parseNumericUserId(userId: string): number | null {
  const trimmed = userId.trim()
  if (!/^\d+$/.test(trimmed)) return null

  const numericUserId = Number.parseInt(trimmed, 10)
  return Number.isSafeInteger(numericUserId) ? numericUserId : null
}

export async function createRuntimeComposition(options: RuntimeCompositionOptions = {}): Promise<RuntimeComposition> {
  const logger = options.logger ?? console

  logger.log('[openagent] Initializing database...')
  const db = initDatabase()

  logger.log('[openagent] Ensuring config templates...')
  ensureConfigTemplates()

  logger.log('[openagent] Ensuring memory structure...')
  ensureMemoryStructure()
  ensureConfigStructure()

  logger.log('[openagent] Injecting global secrets into environment...')
  injectSecretsIntoEnv()

  const runtimeMetrics = new RuntimeMetrics()
  const { sessionTimeoutMinutes, taskSettings, builtinToolsConfig } = loadRuntimeSettings()

  function resolveProvider(nameOrId: string): ProviderConfig | null {
    try {
      const file = loadProvidersDecrypted()
      return file.providers.find(
        p => p.id === nameOrId || p.name.toLowerCase() === nameOrId.toLowerCase(),
      ) ?? null
    } catch {
      return null
    }
  }

  function getTaskDefaultProvider(): ProviderConfig {
    if (taskSettings.defaultProvider) {
      const { providerId, modelId } = parseProviderModelId(taskSettings.defaultProvider)
      if (providerId) {
        let resolved = resolveProvider(providerId)
        if (resolved && modelId) {
          resolved = { ...resolved, defaultModel: modelId }
        }
        if (resolved) return resolved
      }
    }

    return getActiveProvider()!
  }

  const chatEventBus = new ChatEventBus()
  const taskEventBus = new TaskEventBus()

  // Shared SessionManager dedicated to background producers (tasks,
  // heartbeat, consolidation, scheduled jobs, reminders). It only uses
  // `createSession()` to register UUID-based session rows; the per-user
  // interactive session lifecycle is owned by AgentCore's own SessionManager.
  const backgroundSessions = new SessionManager({ db })

  let wsChatPresenceChecker: ((userId: number) => boolean) | null = null

  let agentCore: AgentCore | null = null
  let providerManager: ProviderManager | null = null
  let telegramBot: TelegramBot | null = null

  // Pending task injections keyed by a per-injection UUID. The key is
  // minted here, passed into AgentCore.injectTaskResult as the
  // `injectionId`, and tagged onto every emitted chunk
  // (`chunk.injectionId`) so the handler can correlate chunks with
  // metadata.
  //
  // We MUST key by a per-call token — not by session id — because
  // multiple concurrent task completions for the same user resolve to
  // the same cached interactive session id, and a shared key would
  // collide: the second handleTaskNotification would overwrite the
  // first's metadata before either had streamed.
  const pendingInjections = new Map<string, PendingTaskInjectionMeta>()

  // Reuse one session row per scheduled-reminder id instead of creating a
  // fresh session on every fire. Keeps `sessions` growth O(number of
  // reminders) instead of O(fires). The cache is per-process; after a
  // restart a new session row is created for the reminder's first post-
  // restart fire.
  const reminderSessionByCronjobId = new Map<string, string>()
  function resolveReminderSessionId(cronjobId: string): string {
    const existing = reminderSessionByCronjobId.get(cronjobId)
    if (existing) return existing
    const newId = backgroundSessions.createSession({
      type: 'task',
      source: 'system',
    }).id
    reminderSessionByCronjobId.set(cronjobId, newId)
    return newId
  }
  function evictReminderSession(cronjobId: string): void {
    reminderSessionByCronjobId.delete(cronjobId)
  }

  /**
   * Strictly parse a numeric user id. `Number.parseInt` is too lax
   * (`parseInt('3abc', 10) === 3`) and would silently route task results
   * to the wrong user when `session_user` is a non-numeric username or a
   * malformed string that happens to start with digits. Reject anything
   * that isn't a pure integer literal.
   */
  function parseStrictUserId(value: string | number | null | undefined): number | null {
    if (value == null) return null
    if (typeof value === 'number') {
      return Number.isSafeInteger(value) ? value : null
    }
    const trimmed = value.trim()
    if (!/^-?\d+$/.test(trimmed)) return null
    const parsed = Number(trimmed)
    return Number.isSafeInteger(parsed) ? parsed : null
  }

  /**
   * Resolve the target user for a task result notification by walking the
   * task's session lineage back to the triggering interactive session.
   * Returns null when the task has no interactive parent (cronjob,
   * heartbeat, consolidation) — callers fall back to a default user.
   *
   * User-id precedence when both columns are populated:
   *   1. `session_user` (the canonical identity written by
   *      `SessionManager.getOrCreateSession`, always matches the runtime
   *      userId; for numeric web/telegram users this is `String(n)`).
   *   2. `user_id` (only populated for sessions recovered by the legacy
   *      migration — derived from child-table user_id columns).
   *
   * `session_user` is preferred because it reflects the caller's identity
   * at session creation time; `user_id` is a best-effort backfill.
   */
  function resolveTargetUserIdForTask(taskSessionId: string | null | undefined): number | null {
    if (!taskSessionId) return null
    // Walk up parent_session_id chain until we find a row whose own
    // parent_session_id is NULL. The top-most session is the triggering
    // interactive session.
    let currentId: string | null = taskSessionId
    let safety = 10
    while (currentId && safety-- > 0) {
      const row = db.prepare(
        'SELECT parent_session_id, user_id, session_user FROM sessions WHERE id = ?'
      ).get(currentId) as {
        parent_session_id: string | null
        user_id: number | null
        session_user: string | null
      } | undefined
      if (!row) return null
      if (!row.parent_session_id) {
        // Prefer session_user (canonical identity) over user_id (backfill).
        // Use a strict integer match — `parseInt('3abc', 10) === 3` would
        // otherwise silently route results to the wrong user.
        const parsedSessionUser = parseStrictUserId(row.session_user)
        if (parsedSessionUser !== null) return parsedSessionUser
        const parsedUserId = parseStrictUserId(row.user_id)
        if (parsedUserId !== null) return parsedUserId
        return null
      }
      currentId = row.parent_session_id
    }
    return null
  }

  /**
   * Fallback user when a task has no interactive lineage (cronjob,
   * heartbeat). Uses the lowest-id user in the `users` table. Throws if
   * the query fails or no user exists — an empty users table means the
   * system is misconfigured (admin is provisioned by `ensureAdminUser`
   * during bootstrap), and a DB error must not be silently hidden by
   * returning a hardcoded id that may not exist.
   */
  function getFallbackUserId(): number {
    const row = db.prepare('SELECT id FROM users ORDER BY id ASC LIMIT 1').get() as { id: number } | undefined
    if (!row || !Number.isSafeInteger(row.id)) {
      throw new Error('getFallbackUserId: no users in database (admin not provisioned?)')
    }
    return row.id
  }

  function handleTaskNotification(taskId: string, injection: string, taskRuntime: TaskRuntimeTaskBoundary): void {
    const task = taskRuntime.getById(taskId)
    if (!task) return

    const startMs = task.startedAt ? new Date(task.startedAt.replace(' ', 'T') + 'Z').getTime() : Date.now()
    const endMs = task.completedAt ? new Date(task.completedAt.replace(' ', 'T') + 'Z').getTime() : Date.now()
    const durationMinutes = Math.round((endMs - startMs) / 60000)

    // Resolve target user from the task's session lineage; fall back to
    // the default user when the task has no interactive parent (e.g.
    // cronjob/heartbeat triggered). A non-null task.sessionId with an
    // unresolvable lineage (deleted parent row, chain > depth cap, or
    // malformed linkage) is not an intended fallback — log it so the
    // mis-routed delivery is diagnosable instead of silently reaching the
    // fallback user.
    const resolvedUserId = resolveTargetUserIdForTask(task.sessionId)
    if (resolvedUserId == null && task.sessionId) {
      logger.warn(
        `[openagent] Task ${task.id}: could not resolve target user from session lineage (sessionId=${task.sessionId}); falling back to default user`,
      )
    }
    const userId = resolvedUserId ?? getFallbackUserId()

    // Lineage session (parent interactive, or the task's own session as a
    // last resort). May be null for legacy tasks without sessionId — the
    // helper now returns null instead of throwing so a bad legacy row
    // cannot corrupt task-completion state via the onTaskComplete callback
    // chain.
    const lineageSessionId = resolveTaskNotificationSessionId(db, task)

    // Pre-resolve the single session id that both the persisted `task_result`
    // row AND the streamed injection response will use. This guarantees
    // both writes land in the same session (no split between the old
    // lineage parent and a newly minted interactive session).
    //
    // Correlation between streamed chunks and the pending metadata uses
    // a separate per-injection UUID — NOT the session id — because
    // multiple concurrent task completions for the same user share the
    // same cached session id and would otherwise collide in the map.
    let injectionSessionId: string | null = null
    if (agentCore) {
      injectionSessionId = agentCore.resolveInjectionSessionId(String(userId), lineageSessionId)
      const injectionId = randomUUID()
      pendingInjections.set(injectionId, {
        taskId: task.id,
        userId,
        sessionId: injectionSessionId,
        injectionId,
      })
      const forcedSessionId = injectionSessionId
      agentCore.injectTaskResult(injection, String(userId), forcedSessionId, injectionId).catch(err => {
        logger.error(`[openagent] Failed to inject task result for ${taskId}:`, err)
        pendingInjections.delete(injectionId)
      })
    }

    // Prefer the pre-resolved injection session for persistence so the
    // task-result row and the streamed response share a session. Fall back
    // to the lineage session when no agent core is available (background
    // delivery path). `targetSessionId` may still be undefined — in that
    // case `persistTaskResultMessage` logs and skips rather than throwing.
    const targetSessionId = injectionSessionId ?? lineageSessionId ?? undefined

    deliverTaskNotification({
      db,
      userId,
      task,
      durationMinutes,
      targetSessionId,
      telegramDeliveryMode: (taskSettings.telegramDelivery as 'auto' | 'always') ?? 'auto',
      hasActiveWebSocket: (uid: number) => wsChatPresenceChecker?.(uid) ?? false,
      broadcastEvent: (event) => {
        chatEventBus.broadcast({
          type: event.type,
          userId: event.userId,
          source: 'task',
          taskId: event.taskId,
          taskName: event.taskName,
          taskSummary: event.taskSummary,
          taskDurationMinutes: event.taskDurationMinutes,
          taskTokensUsed: event.taskTokensUsed,
          taskTriggerType: event.taskTriggerType,
        })
      },
    }).catch(err => {
      logger.error(`[openagent] Failed to deliver task notification for ${taskId}:`, err)
    })
  }

  // Background task tools are built as a mutable array so that
  // create_task / list_tasks can be pushed in after taskRuntime is
  // available (they need taskRuntime.tasks — resolved below).
  const backgroundSttEnabled = (() => { try { return loadSttSettings().enabled } catch { return false } })()
  // createBaseAgentTools builds the shared tool set (yolo, web, chat-history,
  // search-memories, agent-skills, transcribe-audio). Both the interactive
  // AgentCore (via agent-runtime.ts) and background tasks use the same factory,
  // so adding a new base tool in one place automatically covers both paths.
  const backgroundTaskTools: AgentTool[] = createBaseAgentTools({
    db,
    builtinToolsConfig,
    sttEnabled: backgroundSttEnabled,
    // Background tasks have no interactive session; search_memories will fall
    // back to the lowest-id user when getCurrentUserId is undefined.
  })

  const taskRuntime = createTaskRuntime({
    db,
    runner: {
      buildModel,
      getApiKey: getApiKeyForProvider,
      sessionManager: backgroundSessions,
      tools: backgroundTaskTools,
      onTaskComplete: (taskId: string, injection: string) => {
        handleTaskNotification(taskId, injection, taskRuntime.tasks)
      },
      onTaskPaused: (taskId: string, injection: string) => {
        handleTaskNotification(taskId, injection, taskRuntime.tasks)
      },
      loopDetection: taskSettings.loopDetection.enabled
        ? {
            enabled: true,
            method: taskSettings.loopDetection.method as LoopDetectionConfig['method'],
            maxConsecutiveFailures: taskSettings.loopDetection.maxConsecutiveFailures,
            smartProvider: taskSettings.loopDetection.smartProvider || undefined,
            smartCheckInterval: taskSettings.loopDetection.smartCheckInterval,
          }
        : undefined,
      statusUpdateIntervalMinutes: taskSettings.statusUpdateIntervalMinutes,
      getProviderById: (id: string) => resolveProvider(id),
      taskEventBus,
    },
    scheduler: {
      getDefaultProvider: getTaskDefaultProvider,
      resolveProvider,
      onInjection: (scheduledTask) => {
        const userId = 1
        const deliveryResults: string[] = []

        // Reuse one `sessions` row per scheduled reminder (keyed by cronjob
        // id) so `sessions` growth is bounded by the number of reminders
        // rather than the number of fires. A reminder firing hourly would
        // otherwise add 8760 session rows per year; with the cache each fire
        // appends a new `tool_calls` row under the same session.
        const reminderSessionId = resolveReminderSessionId(scheduledTask.id)

        chatEventBus.broadcast({
          type: 'reminder',
          userId,
          source: 'task',
          reminderMessage: scheduledTask.prompt,
          reminderName: scheduledTask.name,
          cronjobId: scheduledTask.id,
        })
        deliveryResults.push('chatEventBus: broadcast sent')

        if (telegramBot) {
          const chatId = telegramBot.getTelegramChatIdForUser(userId)
          if (chatId) {
            const telegramHtml = formatReminderTelegramHtml(scheduledTask.name, scheduledTask.prompt)
            telegramBot.sendTaskNotification(chatId, telegramHtml).then(ok => {
              const status = ok ? 'sent' : 'failed'
              logToolCall(db, {
                sessionId: reminderSessionId,
                toolName: 'reminder_delivery',
                input: JSON.stringify({
                  cronjobId: scheduledTask.id,
                  name: scheduledTask.name,
                  message: scheduledTask.prompt,
                  schedule: scheduledTask.schedule,
                }),
                output: JSON.stringify({
                  telegramChatId: chatId,
                  telegramStatus: status,
                  deliveryResults: [...deliveryResults, `telegram: ${status} (chat ${chatId})`],
                }),
                durationMs: 0,
                status: ok ? 'success' : 'error',
              })
            }).catch(err => {
              logger.error(`[openagent] Failed to send Telegram reminder for ${scheduledTask.id}:`, err)
              logToolCall(db, {
                sessionId: reminderSessionId,
                toolName: 'reminder_delivery',
                input: JSON.stringify({
                  cronjobId: scheduledTask.id,
                  name: scheduledTask.name,
                  message: scheduledTask.prompt,
                  schedule: scheduledTask.schedule,
                }),
                output: JSON.stringify({
                  error: (err as Error).message,
                  deliveryResults: [...deliveryResults, `telegram: error - ${(err as Error).message}`],
                }),
                durationMs: 0,
                status: 'error',
              })
            })
            logger.log(`[openagent] Reminder "${scheduledTask.name}" sent via Telegram to chat ${chatId}`)
          } else {
            deliveryResults.push('telegram: no linked chat for this user (requires approved telegram_users entry linked to the same user_id)')
            logger.log(`[openagent] No linked Telegram chat for user ${userId}`)

            chatEventBus.broadcast({
              type: 'system',
              userId,
              source: 'task',
              text: 'Telegram reminder could not be delivered: no approved Telegram account is linked to this user. Open Settings → Telegram, let the Telegram account message the bot, then approve and assign it to this user.',
            })

            logToolCall(db, {
              sessionId: reminderSessionId,
              toolName: 'reminder_delivery',
              input: JSON.stringify({
                cronjobId: scheduledTask.id,
                name: scheduledTask.name,
                message: scheduledTask.prompt,
                schedule: scheduledTask.schedule,
              }),
              output: JSON.stringify({ deliveryResults }),
              durationMs: 0,
              status: 'error',
            })
          }
        } else {
          deliveryResults.push('telegram: bot not available')
          logger.log(`[openagent] No Telegram bot available for reminder "${scheduledTask.name}"`)

          chatEventBus.broadcast({
            type: 'system',
            userId,
            source: 'task',
            text: 'Telegram reminder could not be delivered because the Telegram bot is not available.',
          })

          logToolCall(db, {
            sessionId: reminderSessionId,
            toolName: 'reminder_delivery',
            input: JSON.stringify({
              cronjobId: scheduledTask.id,
              name: scheduledTask.name,
              message: scheduledTask.prompt,
              schedule: scheduledTask.schedule,
            }),
            output: JSON.stringify({ deliveryResults }),
            durationMs: 0,
            status: 'error',
          })
        }

        logger.log(`[openagent] Reminder "${scheduledTask.name}" fired for user ${userId}`)
      },
    },
  })

  const taskToolsOptions = {
    taskRuntime: taskRuntime.tasks,
    getDefaultProvider: getTaskDefaultProvider,
    resolveProvider,
    defaultMaxDurationMinutes: taskSettings.maxDurationMinutes,
    maxDurationMinutesCap: taskSettings.maxDurationMinutes * 2,
    // Link new task sessions to the user's current interactive session via
    // sessions.parent_session_id. Returns null when no interactive session
    // is active (e.g. tool invoked from a background context).
    getParentSessionId: () => agentCore?.getCurrentInteractiveSessionId() ?? null,
  }

  // Now that taskRuntime exists, push create_task / list_tasks into the
  // background-task tool set. The task runner holds a reference to the
  // backgroundTaskTools array, so all subsequently started tasks
  // (heartbeat, cronjob, user-spawned) will see these tools.
  // Background tasks never have an active interactive session, so
  // getParentSessionId always returns null here.
  const backgroundTaskToolsOptions = {
    ...taskToolsOptions,
    getParentSessionId: () => null as string | null,
  }
  backgroundTaskTools.push(
    createTaskTool(backgroundTaskToolsOptions),
    createResumeTaskTool(backgroundTaskToolsOptions),
    listTasksTool({ taskRuntime: taskRuntime.tasks }),
  )

  // Wrap the schedule boundary so deleting a cronjob also evicts its
  // cached reminder session id. Without this, a cronjob deleted mid-
  // process leaves a dangling entry in `reminderSessionByCronjobId`
  // (and an abandoned `sessions` row) that lives for the lifetime of
  // the process.
  const cronjobSchedulesForTools = new Proxy(taskRuntime.schedules, {
    get(target, prop, receiver) {
      if (prop === 'delete') {
        return (id: string) => {
          const deleted = target.delete(id)
          if (deleted) evictReminderSession(id)
          return deleted
        }
      }
      return Reflect.get(target, prop, receiver)
    },
  })

  const cronjobToolsOptions = {
    taskRuntime: cronjobSchedulesForTools,
  }

  // Exclusive tools for the interactive agent only.
  // The base tool set (shell, web, chat-history, memories, skills, stt) is
  // assembled inside agent-runtime.ts via createBaseAgentTools() and does NOT
  // need to be listed here — that keeps both paths in sync automatically.
  const agentTools = [
    createTaskTool(taskToolsOptions),
    createResumeTaskTool(taskToolsOptions),
    listTasksTool({ taskRuntime: taskRuntime.tasks }),
    createCronjobTool(cronjobToolsOptions),
    editCronjobTool(cronjobToolsOptions),
    removeCronjobTool(cronjobToolsOptions),
    listCronjobsTool(cronjobToolsOptions),
    getCronjobTool(cronjobToolsOptions),
    createReminderTool(cronjobToolsOptions),
  ]

  taskRuntime.schedules.start()

  const healthMonitorService = new HealthMonitorService({ db, providerManager: null })
  healthMonitorService.start()

  const consolidationScheduler = new MemoryConsolidationScheduler({
    db,
    agentCore: null,
    taskRuntime: taskRuntime.tasks,
    getDefaultProvider: getTaskDefaultProvider,
    sessionManager: backgroundSessions,
  })
  consolidationScheduler.start()

  const agentHeartbeatService = new AgentHeartbeatService({
    taskRuntime: taskRuntime.tasks,
    getDefaultProvider: getTaskDefaultProvider,
  })
  agentHeartbeatService.start()

  const onTelegramChatEvent = (event: TelegramChatEvent) => {
    if (event.userId == null) return
    chatEventBus.broadcast({
      type: event.type,
      userId: event.userId,
      source: 'telegram',
      sessionId: event.sessionId,
      text: event.text,
      thinking: event.thinking,
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      toolArgs: event.toolArgs,
      toolResult: event.toolResult,
      toolIsError: event.toolIsError,
      senderName: event.senderName,
    })
  }

  function wireAgentCoreEvents(): void {
    if (!agentCore) return

    agentCore.setOnSessionEnd((userId: string, sessionId: string, summary: string | null) => {
      const numericUserId = parseNumericUserId(userId)

      const dividerMetadata = JSON.stringify({ type: 'session_divider', summary: summary ?? null })
      db.prepare(
        'INSERT INTO chat_messages (session_id, user_id, role, content, metadata) VALUES (?, ?, ?, ?, ?)'
      ).run(sessionId, numericUserId, 'system', summary ?? '', dividerMetadata)

      if (numericUserId !== null) {
        chatEventBus.broadcast({
          type: 'session_end',
          userId: numericUserId,
          source: 'web',
          text: summary ?? undefined,
        })
      }

      triggerFactExtractionForSessionEnd({
        db,
        agentCore,
        userId,
        sessionId,
      })
    })

    // Per-injection streaming state, keyed by the unique `injectionId`
    // (NOT the session id). Concurrent injections for the same user
    // share a session id, so keying by session id would cross-contaminate
    // their buffers. `telegramDelivered` is per-injection too so the
    // broadcast on `done` reflects the right delivery state.
    interface InjectionStreamState {
      responseBuffer: string
      telegramDelivered: boolean
    }
    const streamStateByInjection = new Map<string, InjectionStreamState>()

    agentCore.setOnTaskInjectionChunk((chunk) => {
      // Correlate the chunk with its pending metadata via `chunk.injectionId`,
      // which AgentCore guarantees to equal the per-injection UUID we
      // registered in `pendingInjections`. Keying by session id would
      // collide across concurrent injections targeting the same user's
      // cached session — the whole point of the injectionId token.
      const injectionId = chunk.injectionId
      if (!injectionId) {
        logger.warn('[openagent] Task injection chunk has no injectionId; dropping')
        return
      }
      const pendingMeta = pendingInjections.get(injectionId)
      if (!pendingMeta) {
        logger.warn(`[openagent] No pending injection for injectionId ${injectionId}; dropping chunk`)
        return
      }
      const persistSessionId = pendingMeta.sessionId

      let streamState = streamStateByInjection.get(injectionId)
      if (!streamState) {
        streamState = { responseBuffer: '', telegramDelivered: false }
        streamStateByInjection.set(injectionId, streamState)
      }

      try {
        if (chunk.type === 'text' && chunk.text) {
          streamState.responseBuffer += chunk.text
        }

        if (chunk.type === 'done') {
          const responseText = streamState.responseBuffer

          if (telegramBot && responseText) {
            const shouldSend =
              taskSettings.telegramDelivery === 'always' ||
              (taskSettings.telegramDelivery === 'auto' && !(wsChatPresenceChecker?.(pendingMeta.userId) ?? false))

            if (shouldSend) {
              const chatId = telegramBot.getTelegramChatIdForUser(pendingMeta.userId)
              if (chatId) {
                streamState.telegramDelivered = true
                telegramBot.sendFormattedMessage(chatId, responseText).catch(err => {
                  logger.error(`[openagent] Failed to send Telegram for task ${pendingMeta.taskId}:`, err)
                })
              }
            }
          }

          if (responseText) {
            try {
              const metadata = JSON.stringify({ type: 'task_injection_response', telegramDelivered: streamState.telegramDelivered })
              // Persist under the injection session — same id the task-result
              // row was written under in `deliverTaskNotification`, so both
              // rows live together and are reachable via
              // `buildConversationHistory`.
              db.prepare(
                'INSERT INTO chat_messages (session_id, user_id, role, content, metadata) VALUES (?, ?, ?, ?, ?)'
              ).run(persistSessionId, pendingMeta.userId, 'assistant', responseText, metadata)
            } catch (err) {
              logger.error('[openagent] Failed to persist task injection response:', err)
            }
          }
        }

        try {
          chatEventBus.broadcast({
            type: chunk.type === 'done' ? 'done' : chunk.type,
            userId: pendingMeta.userId,
            source: 'task',
            sessionId: persistSessionId,
            text: chunk.text,
            toolName: chunk.toolName,
            toolCallId: chunk.toolCallId,
            toolArgs: chunk.toolArgs,
            toolResult: chunk.toolResult,
            toolIsError: chunk.toolIsError,
            error: chunk.error,
            telegramDelivered: chunk.type === 'done' ? streamState.telegramDelivered : undefined,
            isTaskInjection: true,
          })
        } catch (err) {
          logger.error('[openagent] Failed to broadcast task injection chunk:', err)
        }
      } finally {
        if (chunk.type === 'done') {
          // Clear per-injection state regardless of success/failure so
          // stale buffers can't leak into a subsequent injection.
          streamStateByInjection.delete(injectionId)
          pendingInjections.delete(injectionId)
        }
      }
    })
  }

  async function restartTelegramBot(): Promise<void> {
    if (!agentCore) {
      logger.warn('[openagent] Cannot start Telegram bot: no agent core initialized')
      return
    }

    if (telegramBot) {
      try {
        await telegramBot.stop()
      } catch {
        // ignore
      }
      telegramBot = null
    }

    telegramBot = createTelegramBot(agentCore, db, onTelegramChatEvent)
    if (telegramBot) {
      try {
        await telegramBot.start()
        logger.log('[openagent] Telegram bot (re)started')
      } catch (err) {
        logger.error('[openagent] Failed to start Telegram bot:', err)
        telegramBot = null
      }
    } else {
      logger.log('[openagent] Telegram bot disabled or not configured')
    }
  }

  async function initOrUpdateAgentCore(): Promise<void> {
    const provider = getActiveProvider()
    if (!provider) {
      logger.warn('[openagent] No provider configured — chat will be unavailable. Configure a provider in Settings.')
      return
    }

    const previousAgentCore = agentCore

    try {
      if (previousAgentCore) {
        try {
          await previousAgentCore.endAllSessions()
        } catch (err) {
          logger.error('[openagent] Failed to end sessions before provider change:', err)
        }

        try {
          await previousAgentCore.dispose()
        } catch (err) {
          logger.error('[openagent] Failed to dispose previous agent core:', err)
        }
      }

      const activeModelId = getActiveModelId()
      const model = buildModel(provider, activeModelId ?? undefined)
      const apiKey = await getApiKeyForProvider(provider)
      const fallbackProvider = getFallbackProvider()

      providerManager = new ProviderManager(provider, fallbackProvider)

      agentCore = new AgentCore({
        model,
        apiKey,
        db,
        tools: agentTools,
        providerConfig: provider,
        providerManager,
        sessionTimeoutMinutes,
      })

      providerManager.on('mode:fallback', async () => {
        if (!agentCore || !providerManager) return
        const effectiveProvider = providerManager.getEffectiveProvider()
        if (!effectiveProvider) return

        try {
          const fbModelId = getFallbackModelId()
          const key = await getApiKeyForProvider(effectiveProvider)
          agentCore.swapProvider(effectiveProvider, key, fbModelId ?? undefined)
          logger.log(`[openagent] Swapped to fallback provider: ${effectiveProvider.name} (${fbModelId ?? effectiveProvider.defaultModel})`)
        } catch (err) {
          logger.error('[openagent] Failed to swap to fallback provider:', err)
        }
      })

      providerManager.on('mode:normal', async () => {
        if (!agentCore || !providerManager) return
        const effectiveProvider = providerManager.getEffectiveProvider()
        if (!effectiveProvider) return

        try {
          const actModelId = getActiveModelId()
          const key = await getApiKeyForProvider(effectiveProvider)
          agentCore.swapProvider(effectiveProvider, key, actModelId ?? undefined)
          logger.log(`[openagent] Swapped back to primary provider: ${effectiveProvider.name} (${actModelId ?? effectiveProvider.defaultModel})`)
        } catch (err) {
          logger.error('[openagent] Failed to swap to primary provider:', err)
        }
      })

      healthMonitorService.setProviderManager(providerManager)
      consolidationScheduler.setAgentCore(agentCore)

      wireAgentCoreEvents()

      agentCore.init().catch(err => {
        logger.error('[openagent] Error during agentCore.init():', err)
      })

      await restartTelegramBot()

      logger.log(`[openagent] Agent core initialized with provider: ${provider.name} (${provider.defaultModel})`)
      if (fallbackProvider) {
        logger.log(`[openagent] Fallback provider configured: ${fallbackProvider.name} (${fallbackProvider.defaultModel})`)
      }
    } catch (err) {
      logger.error('[openagent] Failed to initialize agent core:', err)
    }
  }

  await initOrUpdateAgentCore()

  return {
    db,
    runtimeMetrics,
    healthMonitorService,
    consolidationScheduler,
    agentHeartbeatService,
    taskEventBus,
    chatEventBus,
    getAgentCore: () => agentCore,
    getTaskRuntime: () => taskRuntime,
    getTelegramBot: () => telegramBot,
    onTelegramSettingsChanged: () => {
      restartTelegramBot().catch((err) => {
        logger.error('[openagent] Error restarting Telegram bot:', err)
      })
    },
    onActiveProviderChanged: () => {
      initOrUpdateAgentCore().catch((err) => {
        logger.error('[openagent] Error initializing agent core after provider change:', err)
      })
    },
    setWebSocketChatPresenceChecker: (checker) => {
      wsChatPresenceChecker = checker ? checker.hasActiveWebSocket : null
    },
    stopBackgroundServices: async () => {
      healthMonitorService.stop()
      consolidationScheduler.stop()
      agentHeartbeatService.stop()
      taskRuntime.schedules.stop()

      if (telegramBot) {
        try {
          await telegramBot.stop()
        } catch {
          // ignore
        }
        telegramBot = null
      }
    },
  }
}
