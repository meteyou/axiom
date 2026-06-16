import { Router } from 'express'
import type { Database } from '@axiom/core'
import { getActivitySummary, queryHealthCheckHistory } from '@axiom/core'
import { jwtMiddleware } from '../auth.js'
import type { AuthenticatedRequest } from '../auth.js'
import type { HealthMonitorService } from '../health-monitor.js'
import type { RuntimeMetrics } from '../runtime-metrics.js'
import type { AnthropicQuotaContract } from '@axiom/core/contracts'

export interface HealthRouterOptions {
  db: Database
  healthMonitorService: HealthMonitorService
  runtimeMetrics: RuntimeMetrics
  getQuotaSnapshot?: () => Record<string, AnthropicQuotaContract>
}

/**
 * Pick the most relevant Anthropic subscriber quota for the global top-bar
 * indicator: prefer the active provider's quota, then any provider with valid
 * (non-error) data, then any available entry. The snapshot only ever contains
 * anthropic-oauth providers (the quota monitor filters them).
 */
function selectTopBarQuota(
  snapshot: Record<string, AnthropicQuotaContract>,
  activeProviderId: string | null | undefined,
): AnthropicQuotaContract | null {
  if (activeProviderId && snapshot[activeProviderId] && !snapshot[activeProviderId].error) {
    return snapshot[activeProviderId]
  }
  const entries = Object.values(snapshot)
  return entries.find((entry) => !entry.error) ?? entries[0] ?? null
}

export function createHealthRouter(options: HealthRouterOptions): Router {
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
      const snapshot = options.healthMonitorService.getSnapshot()
      const activity = getActivitySummary(options.db)
      const quota = selectTopBarQuota(
        options.getQuotaSnapshot?.() ?? {},
        snapshot.activeProvider?.id,
      )

      res.json({
        agent: {
          status: snapshot.agentStatus,
        },
        enabled: snapshot.enabled,
        operatingMode: snapshot.operatingMode,
        provider: snapshot.activeProvider,
        primaryProvider: snapshot.primaryProvider,
        fallbackProvider: snapshot.fallbackProvider,
        lastCheck: snapshot.lastCheck,
        queueDepth: options.runtimeMetrics.getQueueDepth(),
        activity,
        intervalMinutes: snapshot.intervalMinutes,
        quota,
      })
    } catch (err) {
      res.status(500).json({ error: `Failed to load health snapshot: ${(err as Error).message}` })
    }
  })

  router.get('/history', (req: AuthenticatedRequest, res) => {
    try {
      const page = Math.max(1, Number.parseInt(String(req.query.page ?? '1'), 10) || 1)
      const limit = Math.min(100, Math.max(1, Number.parseInt(String(req.query.limit ?? '20'), 10) || 20))
      const result = queryHealthCheckHistory(options.db, page, limit)
      res.json({ history: result.records, pagination: result.pagination })
    } catch (err) {
      res.status(500).json({ error: `Failed to load health history: ${(err as Error).message}` })
    }
  })

  return router
}
