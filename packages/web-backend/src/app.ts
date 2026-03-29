import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
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
import { createTelegramUsersRouter } from './routes/telegram-users.js'
import type { TelegramBot } from '@openagent/telegram'
import { createSkillsRouter } from './routes/skills.js'
import { createStatsRouter } from './routes/stats.js'
import { createHealthRouter } from './routes/health.js'
import { createTasksRouter } from './routes/tasks.js'
import { createCronjobsRouter } from './routes/cronjobs.js'
import type { TaskRunner, TaskScheduler } from '@openagent/core'
import { ensureAdminUser } from './auth.js'
import type { HeartbeatService } from './heartbeat.js'
import type { RuntimeMetrics } from './runtime-metrics.js'
import type { MemoryConsolidationScheduler } from './memory-consolidation-scheduler.js'

const startTime = Date.now()

export interface AppOptions {
  db: Database
  agentCore?: AgentCore | null
  heartbeatService?: HeartbeatService | null
  runtimeMetrics?: RuntimeMetrics | null
  consolidationScheduler?: MemoryConsolidationScheduler | null
  getTelegramBot?: () => TelegramBot | null
  onTelegramSettingsChanged?: () => void
  getTaskRunner?: () => TaskRunner | null
  getTaskScheduler?: () => TaskScheduler | null
}

export function createApp(options?: AppOptions): express.Express {
  const app = express()

  app.use(express.json())

  // CORS: allow frontend dev server (different port) to access API
  app.use((_req, res, next) => {
    const origin = _req.headers.origin
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
      res.setHeader('Access-Control-Allow-Credentials', 'true')
    }
    if (_req.method === 'OPTIONS') {
      res.status(204).end()
      return
    }
    next()
  })

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
    app.use('/api/providers', createProvidersRouter({
      onActiveProviderChanged: () => {
        options.heartbeatService?.restart({ resetState: true })
      },
    }))
    app.use('/api/memory', createMemoryRouter(options.agentCore ?? null, options.consolidationScheduler ?? null))
    app.use('/api/settings', createSettingsRouter({
      agentCore: options.agentCore ?? null,
      onHeartbeatSettingsChanged: () => {
        options.heartbeatService?.restart()
      },
      onConsolidationSettingsChanged: () => {
        options.consolidationScheduler?.restart()
      },
      onTelegramSettingsChanged: () => {
        options.onTelegramSettingsChanged?.()
      },
    }))
    app.use('/api/users', createUsersRouter(options.db))
    app.use('/api/telegram-users', createTelegramUsersRouter({
      db: options.db,
      getTelegramBot: options.getTelegramBot ?? (() => null),
    }))
    app.use('/api/skills', createSkillsRouter({
      agentCore: options.agentCore ?? null,
    }))
    app.use('/api/stats', createStatsRouter(options.db))
    app.use('/api/tasks', createTasksRouter({
      db: options.db,
      getTaskRunner: options.getTaskRunner,
    }))
    app.use('/api/cronjobs', createCronjobsRouter({
      db: options.db,
      getTaskScheduler: options.getTaskScheduler,
    }))

    if (options.heartbeatService && options.runtimeMetrics) {
      app.use('/api/health', createHealthRouter({
        db: options.db,
        heartbeatService: options.heartbeatService,
        runtimeMetrics: options.runtimeMetrics,
      }))
    }
  }

  // Serve frontend static files (SPA)
  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  // Resolve frontend dir: works from both src/ (dev) and dist/ (production)
  const candidatePaths = [
    process.env.FRONTEND_DIR,
    path.resolve(__dirname, '../../web-frontend/.output/public'),
    path.resolve(__dirname, '../../../web-frontend/.output/public'),
  ].filter(Boolean) as string[]
  const frontendDir = candidatePaths.find(p => fs.existsSync(path.join(p, 'index.html'))) || candidatePaths[0]

  if (fs.existsSync(frontendDir)) {
    console.log(`[openagent] Serving frontend from ${frontendDir}`)
    app.use(express.static(frontendDir))

    // SPA fallback: serve index.html for all non-API/non-WS routes
    app.get('{*path}', (req, res, next) => {
      // Skip API and WebSocket paths — let them 404 naturally with JSON
      if (req.path.startsWith('/api/') || req.path.startsWith('/ws/') || req.path === '/health') {
        next()
        return
      }
      const indexPath = path.join(frontendDir, 'index.html')
      if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath)
      } else {
        res.status(404).send('Frontend not found')
      }
    })
  }

  return app
}
