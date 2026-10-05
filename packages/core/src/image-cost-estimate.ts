import type { Database } from './database.js'

const RECENT_REQUESTS_FOR_ESTIMATE = 5

/**
 * Average billed cost of the most recent image requests for a model, read from
 * `token_usage` (one row per request). pi-ai's image catalog has no per-image
 * prices — flat-priced models list zero, token-priced ones list text-token
 * rates — so earlier billed costs are the only basis for an estimate. Returns
 * `null` until the model has a billed request on record.
 */
export function estimateImageCostPerRequest(db: Database, piAiProvider: string, modelId: string): number | null {
  const rows = db.prepare(
    `SELECT estimated_cost FROM token_usage
     WHERE provider = ? AND model = ? AND estimated_cost > 0
     ORDER BY id DESC LIMIT ?`,
  ).all(piAiProvider, modelId, RECENT_REQUESTS_FOR_ESTIMATE) as Array<{ estimated_cost: number }>
  if (rows.length === 0) return null
  return rows.reduce((sum, row) => sum + row.estimated_cost, 0) / rows.length
}
