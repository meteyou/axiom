import http from 'node:http'
import { createApp } from './app.js'
import { initDatabase } from '@openagent/core'
import { ensureConfigTemplates } from '@openagent/core'
import { ensureMemoryStructure } from '@openagent/core'
import { AgentCore, getActiveProvider, buildModel, getApiKeyForProvider } from '@openagent/core'
import { setupWebSocketChat } from './ws-chat.js'
import { setupWebSocketLogs } from './ws-logs.js'
import { HeartbeatService } from './heartbeat.js'
import { RuntimeMetrics } from './runtime-metrics.js'
import { MemoryConsolidationScheduler } from './memory-consolidation-scheduler.js'
import { createTelegramBot } from '@openagent/telegram'

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
const heartbeatService = new HeartbeatService({ db })
heartbeatService.start()

// Initialize Agent Core with the active provider
let agentCore: AgentCore | null = null
const provider = getActiveProvider()
if (provider) {
  try {
    const model = buildModel(provider)
    const apiKey = await getApiKeyForProvider(provider)
    agentCore = new AgentCore({
      model,
      apiKey,
      db,
      yoloMode: true,
      providerConfig: provider,
    })
    console.log(`[openagent] Agent core initialized with provider: ${provider.name} (${provider.defaultModel})`)
  } catch (err) {
    console.error('[openagent] Failed to initialize agent core:', err)
  }
} else {
  console.warn('[openagent] No provider configured — chat will be unavailable. Configure a provider in Settings.')
}

// Initialize memory consolidation scheduler
const consolidationScheduler = new MemoryConsolidationScheduler({
  db,
  agentCore,
})
consolidationScheduler.start()

// Initialize Telegram bot (if configured and enabled)
const telegramBot = agentCore ? createTelegramBot(agentCore, db) : null
if (telegramBot) {
  telegramBot.start().catch((err) => {
    console.error('[openagent] Failed to start Telegram bot:', err)
  })
}

// Start server
const app = createApp({ db, agentCore, heartbeatService, runtimeMetrics, consolidationScheduler, telegramBot })
const server = http.createServer(app)

// Set up WebSocket chat
setupWebSocketChat(server, db, agentCore, runtimeMetrics)

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
