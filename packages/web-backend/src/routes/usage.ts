import { Router } from 'express'
import type { Database } from '@axiom/core'
import { jwtMiddleware } from '../auth.js'
import type { AuthenticatedRequest } from '../auth.js'

interface UsageSummaryRow {
  requests: number
  promptTokens: number | null
  completionTokens: number | null
  estimatedCost: number | null
}

interface UsageBreakdownRow {
  label: string
  requests: number
  promptTokens: number | null
  completionTokens: number | null
  estimatedCost: number | null
}

export function createUsageRouter(db: Database): Router {
  const router = Router()

  router.use(jwtMiddleware)
  router.use((req: AuthenticatedRequest, res, next) => {
    if (req.user?.role !== 'admin') {
      res.status(403).json({ error: 'Admin access required' })
      return
    }
    next()
  })

  router.get('/', (_req, res) => {
    try {
      const summaryRow = db.prepare(`
        SELECT
          COUNT(*) as requests,
          COALESCE(SUM(prompt_tokens), 0) as promptTokens,
          COALESCE(SUM(completion_tokens), 0) as completionTokens,
          COALESCE(SUM(estimated_cost), 0) as estimatedCost
        FROM token_usage
      `).get() as UsageSummaryRow

      const byProvider = db.prepare(`
        SELECT
          provider as label,
          COUNT(*) as requests,
          COALESCE(SUM(prompt_tokens), 0) as promptTokens,
          COALESCE(SUM(completion_tokens), 0) as completionTokens,
          COALESCE(SUM(estimated_cost), 0) as estimatedCost
        FROM token_usage
        GROUP BY provider
        ORDER BY estimatedCost DESC, requests DESC, label ASC
      `).all() as UsageBreakdownRow[]

      const byModel = db.prepare(`
        SELECT
          model as label,
          COUNT(*) as requests,
          COALESCE(SUM(prompt_tokens), 0) as promptTokens,
          COALESCE(SUM(completion_tokens), 0) as completionTokens,
          COALESCE(SUM(estimated_cost), 0) as estimatedCost
        FROM token_usage
        GROUP BY model
        ORDER BY estimatedCost DESC, requests DESC, label ASC
        LIMIT 10
      `).all() as UsageBreakdownRow[]

      const recent = db.prepare(`
        SELECT
          id,
          timestamp,
          provider,
          model,
          prompt_tokens as promptTokens,
          completion_tokens as completionTokens,
          estimated_cost as estimatedCost,
          session_id as sessionId
        FROM token_usage
        ORDER BY timestamp DESC, id DESC
        LIMIT 25
      `).all()

      const promptTokens = summaryRow.promptTokens ?? 0
      const completionTokens = summaryRow.completionTokens ?? 0
      const estimatedCost = summaryRow.estimatedCost ?? 0

      res.json({
        summary: {
          requests: summaryRow.requests,
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
          estimatedCost,
        },
        byProvider: byProvider.map((row) => ({
          provider: row.label,
          requests: row.requests,
          promptTokens: row.promptTokens ?? 0,
          completionTokens: row.completionTokens ?? 0,
          totalTokens: (row.promptTokens ?? 0) + (row.completionTokens ?? 0),
          estimatedCost: row.estimatedCost ?? 0,
        })),
        byModel: byModel.map((row) => ({
          model: row.label,
          requests: row.requests,
          promptTokens: row.promptTokens ?? 0,
          completionTokens: row.completionTokens ?? 0,
          totalTokens: (row.promptTokens ?? 0) + (row.completionTokens ?? 0),
          estimatedCost: row.estimatedCost ?? 0,
        })),
        recent,
      })
    } catch (err) {
      res.status(500).json({ error: `Failed to read usage data: ${(err as Error).message}` })
    }
  })

  return router
}
