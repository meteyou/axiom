import { Router } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import {
  getMemoryDir,
  ensureMemoryStructure,
  readSoulFile,
  readMemoryFile,
  writeMemoryFile,
} from '@openagent/core'
import type { AgentCore } from '@openagent/core'
import { jwtMiddleware } from '../auth.js'
import type { AuthenticatedRequest } from '../auth.js'
import type { MemoryConsolidationScheduler } from '../memory-consolidation-scheduler.js'

export function createMemoryRouter(getAgentCore: () => AgentCore | null = () => null, consolidationScheduler?: MemoryConsolidationScheduler | null): Router {
  const router = Router()

  router.use(jwtMiddleware)
  router.use((req: AuthenticatedRequest, res, next) => {
    if (req.user?.role !== 'admin') {
      res.status(403).json({ error: 'Admin access required' })
      return
    }
    next()
  })

  function refreshAgentPrompt(): void {
    const agentCore = getAgentCore()
    if (!agentCore) return

    try {
      agentCore.refreshSystemPrompt()
    } catch (err) {
      console.error('[openagent] Failed to refresh system prompt after memory update:', err)
    }
  }

  router.get('/soul', (_req, res) => {
    try {
      const content = readSoulFile()
      res.json({ content })
    } catch (err) {
      res.status(500).json({ error: `Failed to read SOUL.md: ${(err as Error).message}` })
    }
  })

  router.put('/soul', (req: AuthenticatedRequest, res) => {
    const { content } = req.body as { content?: string }
    if (content === undefined || content === null) {
      res.status(400).json({ error: 'Content is required' })
      return
    }

    try {
      const memoryDir = getMemoryDir()
      ensureMemoryStructure(memoryDir)
      const soulPath = path.join(memoryDir, 'SOUL.md')
      fs.writeFileSync(soulPath, content, 'utf-8')
      refreshAgentPrompt()
      res.json({ message: 'SOUL.md updated', content })
    } catch (err) {
      res.status(500).json({ error: `Failed to write SOUL.md: ${(err as Error).message}` })
    }
  })

  // Core memory endpoints (MEMORY.md)
  // Support both /memory (new) and /agents (legacy) paths
  router.get('/core', (_req, res) => {
    try {
      const content = readMemoryFile()
      res.json({ content })
    } catch (err) {
      res.status(500).json({ error: `Failed to read MEMORY.md: ${(err as Error).message}` })
    }
  })

  router.put('/core', (req: AuthenticatedRequest, res) => {
    const { content } = req.body as { content?: string }
    if (content === undefined || content === null) {
      res.status(400).json({ error: 'Content is required' })
      return
    }

    try {
      writeMemoryFile(content)
      refreshAgentPrompt()
      res.json({ message: 'MEMORY.md updated', content })
    } catch (err) {
      res.status(500).json({ error: `Failed to write MEMORY.md: ${(err as Error).message}` })
    }
  })

  // Legacy /agents endpoints for backward compatibility
  router.get('/agents', (_req, res) => {
    try {
      const content = readMemoryFile()
      res.json({ content })
    } catch (err) {
      res.status(500).json({ error: `Failed to read MEMORY.md: ${(err as Error).message}` })
    }
  })

  router.put('/agents', (req: AuthenticatedRequest, res) => {
    const { content } = req.body as { content?: string }
    if (content === undefined || content === null) {
      res.status(400).json({ error: 'Content is required' })
      return
    }

    try {
      writeMemoryFile(content)
      refreshAgentPrompt()
      res.json({ message: 'MEMORY.md updated', content })
    } catch (err) {
      res.status(500).json({ error: `Failed to write MEMORY.md: ${(err as Error).message}` })
    }
  })

  router.get('/daily', (_req, res) => {
    try {
      const memoryDir = getMemoryDir()
      const dailyDir = path.join(memoryDir, 'daily')
      ensureMemoryStructure(memoryDir)

      if (!fs.existsSync(dailyDir)) {
        res.json({ files: [] })
        return
      }

      const entries = fs.readdirSync(dailyDir)
        .filter(f => f.endsWith('.md'))
        .sort()
        .reverse()

      const files = entries.map(filename => {
        const filePath = path.join(dailyDir, filename)
        const stats = fs.statSync(filePath)
        const date = filename.replace('.md', '')
        return {
          filename,
          date,
          size: stats.size,
          modifiedAt: stats.mtime.toISOString(),
        }
      })

      res.json({ files })
    } catch (err) {
      res.status(500).json({ error: `Failed to list daily files: ${(err as Error).message}` })
    }
  })

  router.get('/daily/:date', (req, res) => {
    const { date } = req.params
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' })
      return
    }

    try {
      const memoryDir = getMemoryDir()
      const filePath = path.join(memoryDir, 'daily', `${date}.md`)

      if (!fs.existsSync(filePath)) {
        res.status(404).json({ error: `Daily file for ${date} not found` })
        return
      }

      const content = fs.readFileSync(filePath, 'utf-8')
      res.json({ date, content })
    } catch (err) {
      res.status(500).json({ error: `Failed to read daily file: ${(err as Error).message}` })
    }
  })

  router.put('/daily/:date', (req: AuthenticatedRequest, res) => {
    const rawDate = req.params.date
    const date = Array.isArray(rawDate) ? rawDate[0] : rawDate
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' })
      return
    }

    const { content } = req.body as { content?: string }
    if (content === undefined || content === null) {
      res.status(400).json({ error: 'Content is required' })
      return
    }

    try {
      const memoryDir = getMemoryDir()
      const dailyDir = path.join(memoryDir, 'daily')
      ensureMemoryStructure(memoryDir)

      if (!fs.existsSync(dailyDir)) {
        fs.mkdirSync(dailyDir, { recursive: true })
      }

      const filePath = path.join(dailyDir, `${date}.md`)
      fs.writeFileSync(filePath, content, 'utf-8')
      refreshAgentPrompt()
      res.json({ message: `Daily file for ${date} updated`, date, content })
    } catch (err) {
      res.status(500).json({ error: `Failed to write daily file: ${(err as Error).message}` })
    }
  })

  // Consolidation endpoints
  router.get('/consolidation/status', (_req, res) => {
    if (!consolidationScheduler) {
      res.json({
        enabled: false,
        runAtHour: 3,
        lookbackDays: 3,
        providerId: '',
        lastRun: null,
        lastResult: null,
        nextRunEstimate: null,
      })
      return
    }

    res.json(consolidationScheduler.getSnapshot())
  })

  router.post('/consolidation/run', async (_req, res) => {
    if (!consolidationScheduler) {
      res.status(503).json({ error: 'Consolidation scheduler not available' })
      return
    }

    try {
      const result = await consolidationScheduler.runNow()
      refreshAgentPrompt()
      res.json(result)
    } catch (err) {
      res.status(500).json({ error: `Consolidation failed: ${(err as Error).message}` })
    }
  })

  return router
}
