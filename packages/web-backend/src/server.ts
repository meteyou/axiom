import http from 'node:http'
import { createApp } from './app.js'
import { initDatabase } from '@openagent/core'
import { ensureConfigTemplates } from '@openagent/core'
import { ensureMemoryStructure } from '@openagent/core'
import { AgentCore, getActiveProvider, getFallbackProvider, buildModel, getApiKeyForProvider, loadConfig, ProviderManager } from '@openagent/core'
import { setupWebSocketChat } from './ws-chat.js'
import { setupWebSocketLogs } from './ws-logs.js'
import { HeartbeatService } from './heartbeat.js'
import { RuntimeMetrics } from './runtime-metrics.js'
import { MemoryConsolidationScheduler } from './memory-consolidation-scheduler.js'
import { createTelegramBot } from '@openagent/telegram'
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

// Load session timeout from settings
let sessionTimeoutMinutes = 15
try {
  const settings = loadConfig<{ sessionTimeoutMinutes?: number }>('settings.json')
  if (settings.sessionTimeoutMinutes && settings.sessionTimeoutMinutes > 0) {
    sessionTimeoutMinutes = settings.sessionTimeoutMinutes
  }
} catch { /* use default */ }

// Initialize Agent Core with the active provider
let agentCore: AgentCore | null = null
let providerManager: ProviderManager | null = null
const provider = getActiveProvider()
if (provider) {
  try {
    const model = buildModel(provider)
    const apiKey = await getApiKeyForProvider(provider)

    // Create ProviderManager with primary and optional fallback
    const fallbackProvider = getFallbackProvider()
    providerManager = new ProviderManager(provider, fallbackProvider)

    agentCore = new AgentCore({
      model,
      apiKey,
      db,
      yoloMode: true,
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

    console.log(`[openagent] Agent core initialized with provider: ${provider.name} (${provider.defaultModel})`)
    if (fallbackProvider) {
      console.log(`[openagent] Fallback provider configured: ${fallbackProvider.name} (${fallbackProvider.defaultModel})`)
    }
  } catch (err) {
    console.error('[openagent] Failed to initialize agent core:', err)
  }
} else {
  console.warn('[openagent] No provider configured — chat will be unavailable. Configure a provider in Settings.')
}

// Initialize heartbeat service with provider manager
const heartbeatService = new HeartbeatService({ db, providerManager })
heartbeatService.start()

// Initialize memory consolidation scheduler
const consolidationScheduler = new MemoryConsolidationScheduler({
  db,
  agentCore,
})
consolidationScheduler.start()

// Create the cross-channel chat event bus
const chatEventBus = new ChatEventBus()

// Initialize Telegram bot (if configured and enabled)
// Wire Telegram chat events into the cross-channel event bus
const telegramBot = agentCore
  ? createTelegramBot(agentCore, db, (event) => {
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
    })
  : null
if (telegramBot) {
  telegramBot.start().catch((err) => {
    console.error('[openagent] Failed to start Telegram bot:', err)
  })
}

// Start server
const app = createApp({ db, agentCore, heartbeatService, runtimeMetrics, consolidationScheduler, telegramBot })
const server = http.createServer(app)

// Wire session timeout events into the chat event bus
if (agentCore) {
  agentCore.setOnSessionEnd((userId: string, summary: string | null) => {
    chatEventBus.broadcast({
      type: 'session_end',
      userId: parseInt(userId, 10),
      source: 'web',
      text: summary ?? undefined,
    })
  })
}

// Set up WebSocket chat (with cross-channel event bus)
setupWebSocketChat(server, db, agentCore, runtimeMetrics, chatEventBus)

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
