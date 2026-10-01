import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import { __setPiCatalogForTests, getPiCatalogModels, refreshPiCatalogs } from './pi-catalog.js'
import { buildModel, getAvailableModels } from './provider-config.js'

const bundledIds = getBuiltinModels('anthropic').map(m => m.id)
const bundledSample = getBuiltinModels('anthropic')[0]!

const remoteNew = {
  ...bundledSample,
  id: 'claude-future-9',
  name: 'Claude Future 9',
  contextWindow: 2_000_000,
  cost: { input: 7, output: 35, cacheRead: 0.7, cacheWrite: 8.75 },
  type: 'chat',
}

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json', ...init.headers }, ...init })
}

describe('pi catalog overlay', () => {
  let tmpDir: string
  const originalDataDir = process.env.DATA_DIR

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-pi-catalog-'))
    process.env.DATA_DIR = tmpDir
    __setPiCatalogForTests(undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    __setPiCatalogForTests(undefined)
    if (originalDataDir === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = originalDataDir
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('falls back to the bundled catalog without a cache', () => {
    expect(getPiCatalogModels('anthropic').map(m => m.id)).toEqual(bundledIds)
  })

  it('adds new remote models, updates existing ones and keeps bundled-only entries', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse([
      remoteNew,
      { ...bundledSample, name: 'Renamed upstream' },
      { ...remoteNew, id: 'image-model', type: 'image' },
      { ...remoteNew, id: 'exotic-api', api: 'bedrock-converse-stream' },
      { ...remoteNew, id: 'other-provider', provider: 'openai' },
      { id: 'broken' },
    ], { headers: { etag: '"v1"' } }))

    const [result] = await refreshPiCatalogs(['anthropic', 'anthropic'])

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(String(fetchSpy.mock.calls[0]![0])).toBe('https://pi.dev/api/models/providers/anthropic?types=chat')
    expect(result).toEqual({ piProvider: 'anthropic', status: 'updated', addedModelIds: ['claude-future-9'] })

    const models = getPiCatalogModels('anthropic')
    expect(models.map(m => m.id)).toEqual([...bundledIds, 'claude-future-9'])
    expect(models.find(m => m.id === bundledSample.id)?.name).toBe('Renamed upstream')

    const stored = JSON.parse(fs.readFileSync(path.join(tmpDir, 'config', 'pi-catalog.json'), 'utf-8'))
    expect(stored.providers.anthropic.etag).toBe('"v1"')
  })

  it('makes refreshed models usable for catalog-resolved and api-key providers', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse([remoteNew]))
    await refreshPiCatalogs(['anthropic'])

    expect(getAvailableModels('anthropic').map(m => m.id)).toContain('claude-future-9')

    const oauth = buildModel({
      id: 'a', name: 'Claude', type: 'anthropic-messages', providerType: 'anthropic-oauth', provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com', apiKey: '', enabledModels: ['claude-future-9'], authMethod: 'oauth',
    }, 'claude-future-9')
    expect(oauth).toMatchObject({ name: 'Claude Future 9', contextWindow: 2_000_000, cost: { input: 7 } })

    const apiKey = buildModel({
      id: 'b', name: 'Anthropic', type: 'anthropic-messages', providerType: 'anthropic', provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com', apiKey: 'sk', enabledModels: ['claude-future-9'],
    }, 'claude-future-9')
    expect(apiKey).toMatchObject({ name: 'Claude Future 9', contextWindow: 2_000_000, cost: { input: 7, output: 35, cacheRead: 0.7 } })
  })

  it('sends the etag and treats 304 as unchanged', async () => {
    __setPiCatalogForTests({ anthropic: { checkedAt: 1, etag: '"v1"', models: [remoteNew as never] } })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 304 }))

    const [result] = await refreshPiCatalogs(['anthropic'])

    expect((fetchSpy.mock.calls[0]![1]!.headers as Record<string, string>)['If-None-Match']).toBe('"v1"')
    expect(result!.status).toBe('unchanged')
    expect(getPiCatalogModels('anthropic').map(m => m.id)).toContain('claude-future-9')
  })

  it('keeps the previous cache when a refresh fails', async () => {
    __setPiCatalogForTests({ anthropic: { checkedAt: 1, models: [remoteNew as never] } })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('down', { status: 503 }))

    const [result] = await refreshPiCatalogs(['anthropic'])

    expect(result).toEqual({ piProvider: 'anthropic', status: 'error', addedModelIds: [], error: 'HTTP 503' })
    expect(getPiCatalogModels('anthropic').map(m => m.id)).toContain('claude-future-9')
  })
})
