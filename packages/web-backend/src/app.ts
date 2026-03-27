import express from 'express'
import type { Database } from '@openagent/core'
import type { AgentCore } from '@openagent/core'
import { createAuthRouter } from './routes/auth.js'
import { createChatRouter } from './routes/chat.js'
import { createLogsRouter } from './routes/logs.js'
import { ensureAdminUser } from './auth.js'

const startTime = Date.now()

export interface AppOptions {
  db: Database
  agentCore?: AgentCore | null
}

export function createApp(options?: AppOptions): express.Express {
  const app = express()

  app.use(express.json())

  app.get('/health', (_req, res) => {
    const uptimeMs = Date.now() - startTime
    const uptimeSeconds = Math.floor(uptimeMs / 1000)

    res.json({
      status: 'ok',
      uptime: uptimeSeconds,
      version: '0.1.0',
      timestamp: new Date().toISOString(),
    })
  })

  // Mount auth and chat routes when database is available
  if (options?.db) {
    ensureAdminUser(options.db)
    app.use('/api/auth', createAuthRouter(options.db))
    app.use('/api/chat', createChatRouter(options.db))
    app.use('/api/logs', createLogsRouter(options.db))
  }

  return app
}
