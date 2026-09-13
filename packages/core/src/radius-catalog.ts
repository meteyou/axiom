import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_RADIUS_GATEWAY, loadRadiusGatewayConfig } from '@earendil-works/pi-ai/providers/radius-config'
import type { RadiusGatewayModel } from '@earendil-works/pi-ai/providers/radius-config'
import { getConfigDir } from './config.js'
import type { AvailableModel } from './provider-config.js'

const RADIUS_GATEWAY_URL = DEFAULT_RADIUS_GATEWAY
export const RADIUS_BASE_URL = `${DEFAULT_RADIUS_GATEWAY}/v1`

export type RadiusCatalogModel = RadiusGatewayModel

export interface RadiusCatalog {
  checkedAt: number
  baseUrl: string
  models: RadiusCatalogModel[]
  /** Fetched with a credential, so it may contain organization-private (BYOK) models. */
  authenticated?: boolean
}

const CATALOG_FILE = 'radius-catalog.json'
const STALE_AFTER_MS = 6 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 15_000

let memory: RadiusCatalog | null | undefined
// Keyed by credential: an authenticated refresh must not be satisfied by an
// in-flight anonymous fetch, which would lack the org's private (BYOK) models.
const inflight = new Map<string, Promise<RadiusCatalog>>()

function catalogPath(): string {
  return path.join(getConfigDir(), CATALOG_FILE)
}

function isCatalog(value: unknown): value is RadiusCatalog {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<RadiusCatalog>
  return typeof candidate.checkedAt === 'number'
    && typeof candidate.baseUrl === 'string'
    && Array.isArray(candidate.models)
}

/**
 * Read the persisted catalog. A missing file is the normal first-run state;
 * anything else (unreadable data dir, corrupt JSON) is reported and treated as
 * absent so a broken cache never blocks startup — the next refresh rewrites it.
 */
function loadStored(): RadiusCatalog | null {
  const file = catalogPath()
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    console.warn(`[axiom] Could not read Radius catalog cache ${file}: ${(err as Error).message}`)
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    console.warn(`[axiom] Ignoring corrupt Radius catalog cache ${file}: ${(err as Error).message}`)
    return null
  }
  if (!isCatalog(parsed)) {
    console.warn(`[axiom] Ignoring Radius catalog cache ${file}: unexpected shape`)
    return null
  }
  return parsed
}

function persist(catalog: RadiusCatalog): void {
  const dir = getConfigDir()
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const target = catalogPath()
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(catalog, null, 2) + '\n', 'utf-8')
  fs.renameSync(tmp, target)
}

/**
 * An anonymous fetch only sees the public listing. It must never replace a
 * catalog fetched with an organization credential, or models that are
 * enabled on a provider (BYOK) would vanish from `findRadiusCatalogModel()`.
 */
function shouldStore(fetched: RadiusCatalog, current: RadiusCatalog | null): boolean {
  return fetched.authenticated || !current?.authenticated
}

/**
 * The last successfully fetched Radius catalog (memory → disk), or null when
 * it has never been fetched. Synchronous so `buildModel()` can consult it.
 */
export function getRadiusCatalog(): RadiusCatalog | null {
  if (memory === undefined) memory = loadStored()
  return memory
}

export function findRadiusCatalogModel(modelId: string): (RadiusCatalogModel & { baseUrl: string }) | undefined {
  const catalog = getRadiusCatalog()
  const model = catalog?.models.find(m => m.id === modelId)
  return model ? { ...model, baseUrl: catalog!.baseUrl } : undefined
}

export function isRadiusCatalogStale(catalog: RadiusCatalog | null = getRadiusCatalog()): boolean {
  return !catalog || Date.now() - catalog.checkedAt > STALE_AFTER_MS
}

/**
 * Fetch `/v1/config` from the Radius gateway and persist the result. The
 * endpoint is public; an API key / OAuth access token only adds models that
 * are private to the caller's organization (BYOK). Without `force`, a fresh
 * cached catalog is returned as-is.
 */
export async function refreshRadiusCatalog(options: {
  apiKey?: string
  force?: boolean
  signal?: AbortSignal
} = {}): Promise<RadiusCatalog> {
  const cached = getRadiusCatalog()
  if (cached && !options.force && !isRadiusCatalogStale(cached)) return cached

  const key = options.apiKey ?? ''
  const pending = inflight.get(key)
  if (pending) return pending

  const request = (async () => {
    try {
      const config = await loadRadiusGatewayConfig(
        RADIUS_GATEWAY_URL,
        options.apiKey,
        options.signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
      )
      const catalog: RadiusCatalog = {
        checkedAt: Date.now(),
        baseUrl: config.baseUrl,
        models: config.models,
        authenticated: Boolean(options.apiKey),
      }
      if (shouldStore(catalog, getRadiusCatalog())) {
        memory = catalog
        persist(catalog)
      }
      return catalog
    } finally {
      inflight.delete(key)
    }
  })()
  inflight.set(key, request)
  return request
}

export function radiusCatalogToAvailableModels(catalog: RadiusCatalog | null = getRadiusCatalog()): AvailableModel[] {
  return (catalog?.models ?? [])
    .map(m => ({
      id: m.id,
      name: m.name,
      contextWindow: m.contextWindow,
      cost: { input: m.cost.input, output: m.cost.output },
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
}

/** Test hook: replace the in-memory catalog without touching disk. */
export function __setRadiusCatalogForTests(catalog: RadiusCatalog | null | undefined): void {
  memory = catalog
  inflight.clear()
}
