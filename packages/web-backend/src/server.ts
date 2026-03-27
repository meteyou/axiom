import http from 'node:http'
import { createApp } from './app.js'
import { initDatabase } from '@openagent/core'
import { ensureConfigTemplates } from '@openagent/core'
import { ensureMemoryStructure } from '@openagent/core'
import { setupWebSocketChat } from './ws-chat.js'
import { setupWebSocketLogs } from './ws-logs.js'
import { HeartbeatService } from './heartbeat.js'
import { RuntimeMetrics } from './runtime-metrics.js'

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

// Start server
const app = createApp({ db, heartbeatService, runtimeMetrics })
const server = http.createServer(app)

// Set up WebSocket chat (no agent core connected yet — will be wired in future tasks)
setupWebSocketChat(server, db, null, runtimeMetrics)

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

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    heartbeatService.stop()
  })
}
