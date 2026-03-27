import http from 'node:http'
import { createApp } from './app.js'
import { initDatabase } from '@openagent/core'
import { ensureConfigTemplates } from '@openagent/core'
import { ensureMemoryStructure } from '@openagent/core'
import { setupWebSocketChat } from './ws-chat.js'

const PORT = parseInt(process.env.PORT ?? '3000', 10)
const HOST = process.env.HOST ?? '0.0.0.0'

// Initialize data structures
console.log('[openagent] Initializing database...')
const db = initDatabase()

console.log('[openagent] Ensuring config templates...')
ensureConfigTemplates()

console.log('[openagent] Ensuring memory structure...')
ensureMemoryStructure()

// Start server
const app = createApp({ db })
const server = http.createServer(app)

// Set up WebSocket chat (no agent core connected yet — will be wired in future tasks)
setupWebSocketChat(server, db, null)

server.listen(PORT, HOST, () => {
  console.log(`[openagent] Server running at http://${HOST}:${PORT}`)
  console.log(`[openagent] Health check: http://${HOST}:${PORT}/health`)
  console.log(`[openagent] WebSocket chat: ws://${HOST}:${PORT}/ws/chat`)
})
