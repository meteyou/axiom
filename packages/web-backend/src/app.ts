import express from 'express'
import type { Database } from '@openagent/core'
import type { AgentCore } from '@openagent/core'
import { createAuthRouter } from './routes/auth.js'
import { createChatRouter } from './routes/chat.js'
import { createLogsRouter } from './routes/logs.js'
import { createProvidersRouter } from './routes/providers.js'
import { createMemoryRouter } from './routes/memory.js'
import { createSettingsRouter } from './routes/settings.js'
import { createUsersRouter } from './routes/users.js'
import { createStatsRouter } from './routes/stats.js'
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

  if (options?.db) {
    ensureAdminUser(options.db)
    app.use('/api/auth', createAuthRouter(options.db))
    app.use('/api/chat', createChatRouter(options.db))
    app.use('/api/logs', createLogsRouter(options.db))
    app.use('/api/providers', createProvidersRouter())
    app.use('/api/memory', createMemoryRouter(options.agentCore ?? null))
    app.use('/api/settings', createSettingsRouter(options.agentCore ?? null))
    app.use('/api/users', createUsersRouter(options.db))
    app.use('/api/stats', createStatsRouter(options.db))
  }

  return app
}
