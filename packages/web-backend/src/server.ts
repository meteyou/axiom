import http from 'node:http'
import { createApp } from './app.js'
import { initDatabase } from '@openagent/core'
import { ensureConfigTemplates } from '@openagent/core'
import { ensureMemoryStructure } from '@openagent/core'
import {
  AgentCore,
  getActiveProvider,
  getFallbackProvider,
  buildModel,
  getApiKeyForProvider,
  loadConfig,
  ProviderManager,
  TaskStore,
  TaskRunner,
  TaskScheduler,
  ScheduledTaskStore,
  TaskEventBus,
  createTaskTool,
  createResumeTaskTool,
  createCronjobTool,
  editCronjobTool,
  removeCronjobTool,
  listCronjobsTool,
  createReminderTool,
  listTasksTool,
  loadProvidersDecrypted,
  deliverTaskNotification,
  createYoloTools,
  createBuiltinWebTools,
  logToolCall,
} from '@openagent/core'
import type { ProviderConfig, LoopDetectionConfig, BuiltinToolsConfig } from '@openagent/core'
import { setupWebSocketChat } from './ws-chat.js'
import { setupWebSocketLogs } from './ws-logs.js'
import { setupWebSocketTask } from './ws-task.js'
import { HeartbeatService } from './heartbeat.js'
import { RuntimeMetrics } from './runtime-metrics.js'
import { MemoryConsolidationScheduler } from './memory-consolidation-scheduler.js'
import { createTelegramBot } from '@openagent/telegram'
import type { TelegramBot } from '@openagent/telegram'
import { ChatEventBus } from './chat-event-bus.js'

const PORT = parseInt(process.env.PORT ?? '3000', 10)
const HOST = process.env.HOST ?? '0.0.0.0'

// Initialize data structures
console.log('[openagent] Initializing database...')
const db = initDatabase()

console.log('[openagent] Ensuring config templates...')
ensureConfigTemplates()

console.log('[openagent] Ensuring memory structure...')
ensureMemoryStructure()

const runtimeMetrics = new RuntimeMetrics()

// Load settings
let sessionTimeoutMinutes = 15
let taskSettings = {
  defaultProvider: '',
  maxDurationMinutes: 60,
  telegramDelivery: 'auto' as string,
  loopDetection: {
    enabled: true,
    method: 'systematic' as string,
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
    tasks?: typeof taskSettings
    builtinTools?: BuiltinToolsConfig
    braveSearchApiKey?: string
    searxngUrl?: string
  }>('settings.json')
  if (settings.sessionTimeoutMinutes && settings.sessionTimeoutMinutes > 0) {
    sessionTimeoutMinutes = settings.sessionTimeoutMinutes
  }
  if (settings.tasks) {
    taskSettings = { ...taskSettings, ...settings.tasks }
  }
  builtinToolsConfig = {
    ...settings.builtinTools,
    braveSearchApiKey: settings.braveSearchApiKey ?? settings.builtinTools?.braveSearchApiKey,
    searxngUrl: settings.searxngUrl ?? settings.builtinTools?.searxngUrl,
  }
} catch { /* use default */ }

// Helper: resolve a provider by name or ID
function resolveProvider(nameOrId: string): ProviderConfig | null {
  try {
    const file = loadProvidersDecrypted()
    return file.providers.find(
      p => p.id === nameOrId || p.name.toLowerCase() === nameOrId.toLowerCase()
    ) ?? null
  } catch {
    return null
  }
}

// Helper: get the default provider for tasks
function getTaskDefaultProvider(): ProviderConfig {
  if (taskSettings.defaultProvider) {
    const resolved = resolveProvider(taskSettings.defaultProvider)
    if (resolved) return resolved
  }
  // Fall back to active provider
  return getActiveProvider()!
}

// Create event buses early — needed by TaskRunner and Telegram
const chatEventBus = new ChatEventBus()
const taskEventBus = new TaskEventBus()

// Late-bound reference to WebSocket chat (set after server setup)
let wsChat: { hasActiveWebSocket: (userId: number) => boolean } | null = null

/**
 * Handle task completion/pause notifications:
 * 1. Inject into agent so it can relay to the user
 * 2. Deliver via notification system (persist, broadcast, Telegram)
 */
function handleTaskNotification(taskId: string, injection: string, taskStore: TaskStore): void {
  const task = taskStore.getById(taskId)
  if (!task) return

  // Calculate duration
  const startMs = task.startedAt ? new Date(task.startedAt.replace(' ', 'T') + 'Z').getTime() : Date.now()
  const endMs = task.completedAt ? new Date(task.completedAt.replace(' ', 'T') + 'Z').getTime() : Date.now()
  const durationMinutes = Math.round((endMs - startMs) / 60000)

  // 1. Inject into the main agent so it can respond in chat
  if (agentCore) {
    agentCore.injectTaskResult(injection).catch(err => {
      console.error(`[openagent] Failed to inject task result for ${taskId}:`, err)
    })
  }

  // 2. Deliver notification (persist to DB, broadcast to web clients, optionally Telegram)
  // Determine userId — for user-triggered tasks we'd ideally have a userId,
  // but tasks don't store it. Use admin user (1) as default.
  const userId = 1

  deliverTaskNotification({
    db,
    userId,
    task,
    durationMinutes,
    telegramDeliveryMode: (taskSettings.telegramDelivery as 'auto' | 'always') ?? 'auto',
    hasActiveWebSocket: (uid: number) => wsChat?.hasActiveWebSocket(uid) ?? false,
    sendTelegram: async (message: string) => {
      if (!telegramBot) {
        console.log(`[task-notification] No Telegram bot available for task ${taskId}`)
        return false
      }
      try {
        const chatId = telegramBot.getTelegramChatIdForUser(userId)
        if (!chatId) {
          console.log(`[task-notification] No linked Telegram chat for user ${userId}`)
          return false
        }
        console.log(`[task-notification] Sending Telegram notification for task ${taskId} to chat ${chatId}`)
        return await telegramBot.sendTaskNotification(chatId, message)
      } catch (err) {
        console.error(`[task-notification] Failed to send Telegram for task ${taskId}:`, err)
        return false
      }
    },
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
    console.error(`[openagent] Failed to deliver task notification for ${taskId}:`, err)
  })
}

// Initialize task infrastructure (provider-independent)
const taskStore = new TaskStore(db)
const taskRunner = new TaskRunner({
  db,
  buildModel,
  getApiKey: getApiKeyForProvider,
  tools: [...createYoloTools(), ...createBuiltinWebTools(builtinToolsConfig)],
  onTaskComplete: (taskId: string, injection: string) => {
    handleTaskNotification(taskId, injection, taskStore)
  },
  onTaskPaused: (taskId: string, injection: string) => {
    handleTaskNotification(taskId, injection, taskStore)
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
})

const taskScheduler = new TaskScheduler({
  db,
  taskStore,
  taskRunner,
  getDefaultProvider: getTaskDefaultProvider,
  resolveProvider,
  onInjection: (scheduledTask) => {
    const userId = 1 // Default admin user
    const deliveryResults: string[] = []

    // Reminders are delivered ONLY via Telegram — they do NOT appear in the
    // main agent chat (no chat_messages persistence, no agent injection).
    // The chatEventBus broadcast uses a dedicated 'reminder' type so the
    // frontend can optionally show a toast notification without polluting
    // the chat history.

    // 1. Broadcast via ChatEventBus (frontend can show toast if connected)
    chatEventBus.broadcast({
      type: 'reminder',
      userId,
      source: 'task',
      reminderMessage: scheduledTask.prompt,
      reminderName: scheduledTask.name,
      cronjobId: scheduledTask.id,
    })
    deliveryResults.push('chatEventBus: broadcast sent')

    // 2. Always send Telegram notification (reminders are meant to reach
    //    the user even when they're not looking at the chat)
    if (telegramBot) {
      const chatId = telegramBot.getTelegramChatIdForUser(userId)
      if (chatId) {
        const telegramHtml = `⏰ <b>${escapeHtmlForTelegram(scheduledTask.name)}</b>\n\n${escapeHtmlForTelegram(scheduledTask.prompt)}`
        telegramBot.sendTaskNotification(chatId, telegramHtml).then(ok => {
          // Log delivery result asynchronously
          const status = ok ? 'sent' : 'failed'
          logToolCall(db, {
            sessionId: `cronjob-${scheduledTask.id}`,
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
          console.error(`[openagent] Failed to send Telegram reminder for ${scheduledTask.id}:`, err)
          logToolCall(db, {
            sessionId: `cronjob-${scheduledTask.id}`,
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
        console.log(`[openagent] Reminder "${scheduledTask.name}" sent via Telegram to chat ${chatId}`)
      } else {
        deliveryResults.push('telegram: no linked chat')
        console.log(`[openagent] No linked Telegram chat for user ${userId}`)
        // Log without Telegram
        logToolCall(db, {
          sessionId: `cronjob-${scheduledTask.id}`,
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
      console.log(`[openagent] No Telegram bot available for reminder "${scheduledTask.name}"`)
      // Log without Telegram
      logToolCall(db, {
        sessionId: `cronjob-${scheduledTask.id}`,
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

    console.log(`[openagent] Reminder "${scheduledTask.name}" fired for user ${userId}`)
  },
})

/** Escape HTML for Telegram messages */
function escapeHtmlForTelegram(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

// Build agent tools for tasks and cronjobs
const taskToolsOptions = {
  taskStore,
  taskRunner,
  getDefaultProvider: getTaskDefaultProvider,
  resolveProvider,
  defaultMaxDurationMinutes: taskSettings.maxDurationMinutes,
  maxDurationMinutesCap: taskSettings.maxDurationMinutes * 2,
}

const scheduledTaskStore = new ScheduledTaskStore(db)
const cronjobToolsOptions = {
  scheduledTaskStore,
  taskScheduler,
}

const agentTools = [
  createTaskTool(taskToolsOptions),
  createResumeTaskTool(taskToolsOptions),
  listTasksTool({ taskStore }),
  createCronjobTool(cronjobToolsOptions),
  editCronjobTool(cronjobToolsOptions),
  removeCronjobTool(cronjobToolsOptions),
  listCronjobsTool(cronjobToolsOptions),
  createReminderTool(cronjobToolsOptions),
]

// Start the task scheduler to pick up existing cronjobs
taskScheduler.start()

// Provider-dependent state (initialized lazily when a provider is configured)
let agentCore: AgentCore | null = null
let providerManager: ProviderManager | null = null
let telegramBot: TelegramBot | null = null

// Initialize services early (updated via setters when agentCore/providerManager become available)
const heartbeatService = new HeartbeatService({ db, providerManager: null })
heartbeatService.start()

const consolidationScheduler = new MemoryConsolidationScheduler({ db, agentCore: null })
consolidationScheduler.start()

// Wire Telegram chat events into the cross-channel event bus
const onTelegramChatEvent = (event: import('@openagent/telegram').TelegramChatEvent) => {
  if (event.userId == null) return // unlinked telegram users can't sync
  chatEventBus.broadcast({
    type: event.type,
    userId: event.userId,
    source: 'telegram',
    sessionId: event.sessionId,
    text: event.text,
    toolName: event.toolName,
    toolCallId: event.toolCallId,
    toolArgs: event.toolArgs,
    toolResult: event.toolResult,
    toolIsError: event.toolIsError,
    senderName: event.senderName,
  })
}

/**
 * Wire session/task-injection events on agentCore.
 * Called each time agentCore is (re)created.
 */
function wireAgentCoreEvents(): void {
  if (!agentCore) return

  agentCore.setOnSessionEnd((userId: string, summary: string | null) => {
    chatEventBus.broadcast({
      type: 'session_end',
      userId: parseInt(userId, 10),
      source: 'web',
      text: summary ?? undefined,
    })
  })

  let taskInjectionResponseBuffer = ''
  agentCore.setOnTaskInjectionChunk((chunk) => {
    if (chunk.type === 'text' && chunk.text) {
      taskInjectionResponseBuffer += chunk.text
    }

    if (chunk.type === 'done' && taskInjectionResponseBuffer) {
      const responseText = taskInjectionResponseBuffer
      taskInjectionResponseBuffer = ''
      try {
        db.prepare(
          'INSERT INTO chat_messages (session_id, user_id, role, content, metadata) VALUES (?, ?, ?, ?, ?)'
        ).run(`task-injection-${Date.now()}`, 1, 'assistant', responseText, JSON.stringify({ type: 'task_injection_response' }))
      } catch (err) {
        console.error('[openagent] Failed to persist task injection response:', err)
      }
    }

    chatEventBus.broadcast({
      type: chunk.type === 'done' ? 'done' : chunk.type,
      userId: 1,
      source: 'task',
      text: chunk.text,
      toolName: chunk.toolName,
      toolCallId: chunk.toolCallId,
      toolArgs: chunk.toolArgs,
      toolResult: chunk.toolResult,
      toolIsError: chunk.toolIsError,
      error: chunk.error,
    })
  })
}

/**
 * (Re-)create and start the Telegram bot.
 * Stops the previous instance if running.
 */
async function restartTelegramBot(): Promise<void> {
  if (!agentCore) {
    console.warn('[openagent] Cannot start Telegram bot: no agent core initialized')
    return
  }

  // Stop previous instance
  if (telegramBot) {
    try {
      await telegramBot.stop()
    } catch { /* ignore */ }
    telegramBot = null
  }

  // Try to create a new bot with the (potentially updated) config
  telegramBot = createTelegramBot(agentCore, db, onTelegramChatEvent)
  if (telegramBot) {
    try {
      await telegramBot.start()
      console.log('[openagent] Telegram bot (re)started')
    } catch (err) {
      console.error('[openagent] Failed to start Telegram bot:', err)
      telegramBot = null
    }
  } else {
    console.log('[openagent] Telegram bot disabled or not configured')
  }
}

/**
 * Initialize or update the agent core when the active provider changes.
 * Creates providerManager + agentCore, wires events, updates dependent services.
 */
async function initOrUpdateAgentCore(): Promise<void> {
  const provider = getActiveProvider()
  if (!provider) {
    console.warn('[openagent] No provider configured \u2014 chat will be unavailable. Configure a provider in Settings.')
    return
  }

  try {
    const model = buildModel(provider)
    const apiKey = await getApiKeyForProvider(provider)
    const fallbackProvider = getFallbackProvider()

    providerManager = new ProviderManager(provider, fallbackProvider)

    agentCore = new AgentCore({
      model,
      apiKey,
      db,
      yoloMode: true,
      tools: agentTools,
      providerConfig: provider,
      providerManager,
      sessionTimeoutMinutes,
    })

    // Wire ProviderManager events to AgentCore.swapProvider()
    providerManager.on('mode:fallback', async () => {
      if (!agentCore || !providerManager) return
      const effectiveProvider = providerManager.getEffectiveProvider()
      if (!effectiveProvider) return
      try {
        const key = await getApiKeyForProvider(effectiveProvider)
        agentCore.swapProvider(effectiveProvider, key)
        console.log(`[openagent] Swapped to fallback provider: ${effectiveProvider.name} (${effectiveProvider.defaultModel})`)
      } catch (err) {
        console.error('[openagent] Failed to swap to fallback provider:', err)
      }
    })

    providerManager.on('mode:normal', async () => {
      if (!agentCore || !providerManager) return
      const effectiveProvider = providerManager.getEffectiveProvider()
      if (!effectiveProvider) return
      try {
        const key = await getApiKeyForProvider(effectiveProvider)
        agentCore.swapProvider(effectiveProvider, key)
        console.log(`[openagent] Swapped back to primary provider: ${effectiveProvider.name} (${effectiveProvider.defaultModel})`)
      } catch (err) {
        console.error('[openagent] Failed to swap to primary provider:', err)
      }
    })

    // Update dependent services with new references
    heartbeatService.setProviderManager(providerManager)
    consolidationScheduler.setAgentCore(agentCore)

    // Wire agent core events (session end, task injection)
    wireAgentCoreEvents()

    // Try to start Telegram bot if configured
    await restartTelegramBot()

    console.log(`[openagent] Agent core initialized with provider: ${provider.name} (${provider.defaultModel})`)
    if (fallbackProvider) {
      console.log(`[openagent] Fallback provider configured: ${fallbackProvider.name} (${fallbackProvider.defaultModel})`)
    }
  } catch (err) {
    console.error('[openagent] Failed to initialize agent core:', err)
  }
}

// Initial agent core setup
await initOrUpdateAgentCore()

// Start server
const app = createApp({
  db,
  getAgentCore: () => agentCore,
  heartbeatService,
  runtimeMetrics,
  consolidationScheduler,
  getTaskRunner: () => taskRunner,
  getTaskScheduler: () => taskScheduler,
  getTelegramBot: () => telegramBot,
  onTelegramSettingsChanged: () => {
    restartTelegramBot().catch((err) => {
      console.error('[openagent] Error restarting Telegram bot:', err)
    })
  },
  onActiveProviderChanged: () => {
    initOrUpdateAgentCore().catch((err) => {
      console.error('[openagent] Error initializing agent core after provider change:', err)
    })
  },
  taskEventBus,
})
const server = http.createServer(app)

// Set up WebSocket chat (with cross-channel event bus and dynamic agentCore getter)
wsChat = setupWebSocketChat(server, db, () => agentCore, runtimeMetrics, chatEventBus)

// Set up WebSocket task viewer (live event streaming)
setupWebSocketTask({ server, db, taskEventBus })

// Set up WebSocket logs for real-time streaming
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const { wss: _logsWss, broadcast: broadcastLog } = setupWebSocketLogs(server)
// broadcastLog can be called to stream new log entries to connected WebSocket clients
void broadcastLog

server.listen(PORT, HOST, () => {
  console.log(`[openagent] Server running at http://${HOST}:${PORT}`)
  console.log(`[openagent] Health check: http://${HOST}:${PORT}/health`)
  console.log(`[openagent] WebSocket chat: ws://${HOST}:${PORT}/ws/chat`)
  console.log(`[openagent] WebSocket logs: ws://${HOST}:${PORT}/ws/logs`)
  console.log(`[openagent] WebSocket task viewer: ws://${HOST}:${PORT}/ws/task/:id`)
})

let shuttingDown = false

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (shuttingDown) return
    shuttingDown = true

    console.log(`\n[openagent] Received ${signal}, shutting down...`)
    heartbeatService.stop()
    consolidationScheduler.stop()

    const cleanup = async () => {
      try {
        await telegramBot?.stop()
      } catch { /* ignore */ }
      server.close(() => {
        console.log('[openagent] Server closed.')
        process.exit(0)
      })
      // Force exit after 3s if something hangs
      setTimeout(() => process.exit(1), 3000).unref()
    }

    cleanup().catch(() => process.exit(1))
  })
}
