import fs from 'node:fs'
import path from 'node:path'
import type { Api, Model } from '@earendil-works/pi-ai'
import { getBuiltinModelDataGeneratedAt, getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import type { BuiltinProvider } from '@earendil-works/pi-ai/providers/all'
import { getConfigDir } from './config.js'
import { SUPPORTED_APIS } from './pi-models.js'

/**
 * Remote overlay for the model catalog bundled with `@earendil-works/pi-ai`.
 * pi.dev publishes the same catalog the pi CLI overlays (`pi update --models`),
 * so models released after the installed pi-ai version become usable without a
 * dependency upgrade. Refreshing is manual (Providers page); the last result is
 * cached in `config/pi-catalog.json` so it survives restarts and works offline.
 */

const PI_CATALOG_BASE_URL = 'https://pi.dev'

/**
 * pi.dev keeps one catalog per minimum pi version and answers requests without
 * `pi-version` with the newest one, which may need a newer pi-ai than Axiom
 * ships. Must match the installed `@earendil-works/pi-ai` (locked by
 * `pi-catalog.test.ts`).
 */
const PI_AI_VERSION = '1.3.0'

const CATALOG_FILE = 'pi-catalog.json'
const FETCH_TIMEOUT_MS = 15_000

interface StoredProviderCatalog {
  checkedAt: number
  /** `Last-Modified` of the pi.dev response (epoch ms). */
  lastModified?: number
  etag?: string
  models: Model<Api>[]
}

interface StoredCatalog {
  providers: Record<string, StoredProviderCatalog>
}

export interface PiCatalogRefreshResult {
  /** pi-ai provider id (e.g. `anthropic`, `openai-codex`). */
  piProvider: string
  status: 'updated' | 'unchanged' | 'error'
  /** Model ids that were not available before this refresh. */
  addedModelIds: string[]
  error?: string
}

let memory: StoredCatalog | undefined

function catalogPath(): string {
  return path.join(getConfigDir(), CATALOG_FILE)
}

/** A broken cache must never block startup — it is treated as empty and rewritten by the next refresh. */
function loadStored(): StoredCatalog {
  let raw: string
  try {
    raw = fs.readFileSync(catalogPath(), 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[axiom] Could not read pi catalog cache: ${(err as Error).message}`)
    }
    return { providers: {} }
  }
  try {
    const parsed = JSON.parse(raw) as Partial<StoredCatalog>
    if (parsed && typeof parsed.providers === 'object' && parsed.providers !== null) {
      return { providers: parsed.providers as Record<string, StoredProviderCatalog> }
    }
  } catch (err) {
    console.warn(`[axiom] Ignoring corrupt pi catalog cache: ${(err as Error).message}`)
  }
  return { providers: {} }
}

function getStored(): StoredCatalog {
  memory ??= loadStored()
  return memory
}

function persist(catalog: StoredCatalog): void {
  const dir = getConfigDir()
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const target = catalogPath()
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(catalog, null, 2) + '\n', 'utf-8')
  fs.renameSync(tmp, target)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Keep only chat models Axiom can actually dispatch. Entries from a newer
 * catalog schema or for wire APIs this build does not implement are dropped,
 * so they can never shadow a working bundled entry.
 */
function isUsableRemoteModel(value: unknown, piProvider: string): value is Model<Api> {
  if (typeof value !== 'object' || value === null) return false
  const m = value as Record<string, unknown>
  const cost = m.cost as Record<string, unknown> | undefined
  return typeof m.id === 'string' && m.id.length > 0
    && (m.type === undefined || m.type === 'chat')
    && m.provider === piProvider
    && typeof m.api === 'string' && SUPPORTED_APIS.has(m.api as Api)
    && typeof m.baseUrl === 'string'
    && typeof m.reasoning === 'boolean'
    && Array.isArray(m.input)
    && isFiniteNumber(m.contextWindow) && isFiniteNumber(m.maxTokens)
    && typeof cost === 'object' && cost !== null
    && isFiniteNumber(cost.input) && isFiniteNumber(cost.output)
    && isFiniteNumber(cost.cacheRead) && isFiniteNumber(cost.cacheWrite)
}

function bundledModels(piProvider: string): Model<Api>[] {
  try {
    return getBuiltinModels(piProvider as BuiltinProvider) as Model<Api>[]
  } catch {
    return []
  }
}

/**
 * A remote catalog older than the bundled data (e.g. cached before an Axiom
 * update) would roll newer bundled entries back, so it is ignored like the pi
 * CLI does. Entries saved without `lastModified` count as older.
 */
function isNewerThanBundled(entry: StoredProviderCatalog): boolean {
  const bundledAt = getBuiltinModelDataGeneratedAt()
  return bundledAt === undefined || (entry.lastModified ?? 0) > bundledAt
}

function remoteModels(entry: StoredProviderCatalog | undefined): Model<Api>[] {
  return entry && isNewerThanBundled(entry) ? entry.models : []
}

/**
 * The effective catalog for a pi-ai provider: bundled models with the last
 * fetched remote models layered on top (remote wins per id). Synchronous so
 * `buildModel()` can use it. Bundled entries missing remotely are kept, like
 * the pi CLI does, so an incomplete remote response never removes models.
 */
export function getPiCatalogModels(piProvider: string): Model<Api>[] {
  const merged = new Map(bundledModels(piProvider).map(m => [m.id, m]))
  for (const model of remoteModels(getStored().providers[piProvider])) {
    merged.set(model.id, model)
  }
  return Array.from(merged.values())
}

function parseHttpDate(value: string | null): number | undefined {
  const time = Date.parse(value ?? '')
  return Number.isNaN(time) ? undefined : time
}

async function fetchProviderCatalog(
  piProvider: string,
  etag: string | undefined,
  signal: AbortSignal,
): Promise<{ notModified: true } | { notModified: false; models: Model<Api>[]; etag?: string; lastModified?: number }> {
  const url = new URL(`/api/models/providers/${encodeURIComponent(piProvider)}`, PI_CATALOG_BASE_URL)
  url.searchParams.set('types', 'chat')
  url.searchParams.set('pi-version', PI_AI_VERSION)
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      ...(etag ? { 'If-None-Match': etag } : {}),
    },
    signal,
  })
  if (response.status === 304) return { notModified: true }
  if (!response.ok) throw new Error(`HTTP ${response.status}`)

  const body = await response.json() as unknown
  const entries = Array.isArray(body) ? body : []
  return {
    notModified: false,
    models: entries.filter((entry): entry is Model<Api> => isUsableRemoteModel(entry, piProvider)),
    etag: response.headers.get('etag') ?? undefined,
    lastModified: parseHttpDate(response.headers.get('last-modified')),
  }
}

/**
 * Fetch the pi.dev catalog for each given pi-ai provider and persist the
 * results. Providers are refreshed independently: one failing provider keeps
 * its previous cache and is reported as `error`.
 */
export async function refreshPiCatalogs(
  piProviders: string[],
  options: { signal?: AbortSignal } = {},
): Promise<PiCatalogRefreshResult[]> {
  const unique = Array.from(new Set(piProviders))
  const stored = getStored()

  const results = await Promise.all(unique.map(async (piProvider): Promise<PiCatalogRefreshResult> => {
    const before = new Set(getPiCatalogModels(piProvider).map(m => m.id))
    const previous = stored.providers[piProvider]
    try {
      const signal = options.signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS)
      // Entries cached without `lastModified` stay ignored on a 304, so they are downloaded again.
      const etag = previous?.models.length && previous.lastModified !== undefined ? previous.etag : undefined
      const fetched = await fetchProviderCatalog(piProvider, etag, signal)
      if (fetched.notModified) {
        stored.providers[piProvider] = { ...previous!, checkedAt: Date.now() }
        return { piProvider, status: 'unchanged', addedModelIds: [] }
      }
      stored.providers[piProvider] = {
        checkedAt: Date.now(),
        lastModified: fetched.lastModified,
        etag: fetched.etag,
        models: fetched.models,
      }
      const addedModelIds = getPiCatalogModels(piProvider).map(m => m.id).filter(id => !before.has(id))
      return { piProvider, status: addedModelIds.length > 0 ? 'updated' : 'unchanged', addedModelIds }
    } catch (err) {
      return { piProvider, status: 'error', addedModelIds: [], error: (err as Error).message }
    }
  }))

  if (results.some(r => r.status !== 'error')) persist(stored)
  return results
}

/** Test hook: replace the in-memory cache without touching disk. */
export function __setPiCatalogForTests(providers: Record<string, StoredProviderCatalog> | undefined): void {
  memory = providers ? { providers } : undefined
}
