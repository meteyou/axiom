import {
  AgentCore,
  AgentHeartbeatService,
  buildModel,
  createBuiltinWebTools,
  createCronjobTool,
  createReadChatHistoryTool,
  createReminderTool,
  createResumeTaskTool,
  createSearchMemoriesTool,
  createTaskRuntime,
  createTaskTool,
  createYoloTools,
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
  /** Resolved interactive session ID to persist the agent's response under */
  targetSessionId: string
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

  const pendingTaskInjections: PendingTaskInjectionMeta[] = []

  /**
   * Resolve the target user for a task result notification by walking the
   * task's session lineage back to the triggering interactive session.
   * Returns null when the task has no interactive parent (cronjob,
   * heartbeat, consolidation) — callers fall back to a default user.
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
        'SELECT parent_session_id, session_user FROM sessions WHERE id = ?'
      ).get(currentId) as { parent_session_id: string | null; session_user: string | null } | undefined
      if (!row) return null
      if (!row.parent_session_id) {
        const uid = row.session_user ? Number.parseInt(row.session_user, 10) : NaN
        return Number.isSafeInteger(uid) ? uid : null
      }
      currentId = row.parent_session_id
    }
    return null
  }

  /**
   * Fallback user when a task has no interactive lineage (cronjob,
   * heartbeat). Uses the lowest-id user in the users table.
   */
  function getFallbackUserId(): number {
    try {
      const row = db.prepare('SELECT id FROM users ORDER BY id ASC LIMIT 1').get() as { id: number } | undefined
      if (row && Number.isSafeInteger(row.id)) return row.id
    } catch {
      // ignore
    }
    return 1
  }

  function handleTaskNotification(taskId: string, injection: string, taskRuntime: TaskRuntimeTaskBoundary): void {
    const task = taskRuntime.getById(taskId)
    if (!task) return

    const startMs = task.startedAt ? new Date(task.startedAt.replace(' ', 'T') + 'Z').getTime() : Date.now()
    const endMs = task.completedAt ? new Date(task.completedAt.replace(' ', 'T') + 'Z').getTime() : Date.now()
    const durationMinutes = Math.round((endMs - startMs) / 60000)

    // Resolve target user from the task's session lineage; fall back to
    // the default user when the task has no interactive parent (e.g.
    // cronjob/heartbeat triggered).
    const resolvedUserId = resolveTargetUserIdForTask(task.sessionId)
    const userId = resolvedUserId ?? getFallbackUserId()

    // Resolve the chat session ID for persistence/merging: parent
    // interactive session (preferred) or the task's own session as
    // fallback for background tasks.
    const targetSessionId = resolveTaskNotificationSessionId(db, task)

    if (agentCore) {
      pendingTaskInjections.push({ taskId: task.id, userId, targetSessionId })
      agentCore.injectTaskResult(injection, String(userId)).catch(err => {
        logger.error(`[openagent] Failed to inject task result for ${taskId}:`, err)
        const idx = pendingTaskInjections.findIndex(p => p.taskId === task.id)
        if (idx >= 0) pendingTaskInjections.splice(idx, 1)
      })
    }

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

  const taskRuntime = createTaskRuntime({
    db,
    runner: {
      buildModel,
      getApiKey: getApiKeyForProvider,
      sessionManager: backgroundSessions,
      tools: [
        ...createYoloTools(),
        ...createBuiltinWebTools(builtinToolsConfig),
        createReadChatHistoryTool({ db }),
        createSearchMemoriesTool({ db }),
      ],
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

        // Register a UUID session for this reminder fire so all log entries
        // for this delivery share a single session row in `sessions`
        // (type='task' — reminders are background actions without an
        // executing LLM, but stored under the task type per Task 4 spec).
        const reminderSessionId = backgroundSessions.createSession({
          type: 'task',
          source: 'system',
        }).id

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

  const cronjobToolsOptions = {
    taskRuntime: taskRuntime.schedules,
  }

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
    createReadChatHistoryTool({ db }),
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

    let taskInjectionResponseBuffer = ''
    let lastTelegramDelivered = false
    let activeTaskInjectionMeta: PendingTaskInjectionMeta | null = null

    agentCore.setOnTaskInjectionChunk((chunk) => {
      // A task injection emits multiple chunks (text/thinking/tool/done).
      // Bind the whole chunk stream to one pending metadata entry so each
      // chunk is broadcast/persisted for the correct target user.
      if (!activeTaskInjectionMeta && pendingTaskInjections.length > 0) {
        activeTaskInjectionMeta = pendingTaskInjections.shift() ?? null
      }
      const pendingMeta = activeTaskInjectionMeta

      if (chunk.type === 'text' && chunk.text) {
        taskInjectionResponseBuffer += chunk.text
      }

      if (chunk.type === 'done') {
        const responseText = taskInjectionResponseBuffer
        taskInjectionResponseBuffer = ''
        lastTelegramDelivered = false

        if (pendingMeta && telegramBot && responseText) {
          const shouldSend =
            taskSettings.telegramDelivery === 'always' ||
            (taskSettings.telegramDelivery === 'auto' && !(wsChatPresenceChecker?.(pendingMeta.userId) ?? false))

          if (shouldSend) {
            const chatId = telegramBot.getTelegramChatIdForUser(pendingMeta.userId)
            if (chatId) {
              lastTelegramDelivered = true
              telegramBot.sendFormattedMessage(chatId, responseText).catch(err => {
                logger.error(`[openagent] Failed to send Telegram for task ${pendingMeta.taskId}:`, err)
              })
            }
          }
        }

        if (responseText) {
          try {
            const metadata = JSON.stringify({ type: 'task_injection_response', telegramDelivered: lastTelegramDelivered })
            // Persist the agent's injection response under the resolved
            // interactive session (preferred) or the task session as
            // fallback — never under a synthetic `task-injection-*` ID.
            const persistSessionId = pendingMeta?.targetSessionId
            const persistUserId = pendingMeta?.userId ?? getFallbackUserId()
            if (persistSessionId) {
              db.prepare(
                'INSERT INTO chat_messages (session_id, user_id, role, content, metadata) VALUES (?, ?, ?, ?, ?)'
              ).run(persistSessionId, persistUserId, 'assistant', responseText, metadata)
            } else {
              logger.warn('[openagent] No target session resolved for task injection response; skipping persist')
            }
          } catch (err) {
            logger.error('[openagent] Failed to persist task injection response:', err)
          }
        }
      }

      if (pendingMeta) {
        chatEventBus.broadcast({
          type: chunk.type === 'done' ? 'done' : chunk.type,
          userId: pendingMeta.userId,
          source: 'task',
          text: chunk.text,
          toolName: chunk.toolName,
          toolCallId: chunk.toolCallId,
          toolArgs: chunk.toolArgs,
          toolResult: chunk.toolResult,
          toolIsError: chunk.toolIsError,
          error: chunk.error,
          telegramDelivered: chunk.type === 'done' ? lastTelegramDelivered : undefined,
          isTaskInjection: true,
        })
      } else {
        logger.warn('[openagent] Missing task injection metadata; dropping streamed chunk broadcast')
      }

      if (chunk.type === 'done') {
        activeTaskInjectionMeta = null
        lastTelegramDelivered = false
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
