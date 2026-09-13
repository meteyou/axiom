import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const { loadRadiusGatewayConfig } = vi.hoisted(() => ({ loadRadiusGatewayConfig: vi.fn() }))
vi.mock('@earendil-works/pi-ai/providers/radius-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@earendil-works/pi-ai/providers/radius-config')>()
  return { ...actual, loadRadiusGatewayConfig }
})

import {
  __setRadiusCatalogForTests,
  getRadiusCatalog,
  isRadiusCatalogStale,
  radiusCatalogToAvailableModels,
  refreshRadiusCatalog,
  RADIUS_BASE_URL,
} from './radius-catalog.js'
import {
  addProvider,
  buildModel,
  getAvailableModels,
  isDynamicCatalogProvider,
  isRadiusProviderType,
  PROVIDER_TYPE_PRESETS,
  updateProviderModel,
} from './provider-config.js'
import type { RadiusCatalog } from './radius-catalog.js'

const kimi = {
  id: 'kimi-k3',
  name: 'Kimi K3',
  reasoning: true,
  thinkingLevelMap: { off: null, low: 'low', high: 'high' },
  input: ['text', 'image'] as ('text' | 'image')[],
  contextWindow: 1_048_576,
  maxTokens: 131_072,
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
}

const sampleCatalog: RadiusCatalog = {
  checkedAt: Date.now(),
  baseUrl: 'https://radius.pi.dev/v1',
  models: [kimi, { ...kimi, id: 'glm-5.3', name: 'GLM 5.3', reasoning: false, thinkingLevelMap: undefined }],
}

function useTempDataDir(initialCatalog: RadiusCatalog | undefined) {
  let tmpDir: string
  const originalDataDir = process.env.DATA_DIR

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-radius-'))
    process.env.DATA_DIR = tmpDir
    __setRadiusCatalogForTests(initialCatalog)
    loadRadiusGatewayConfig.mockReset()
  })

  afterEach(() => {
    __setRadiusCatalogForTests(undefined)
    fs.rmSync(tmpDir, { recursive: true, force: true })
    if (originalDataDir === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = originalDataDir
  })

  return { dir: () => tmpDir }
}

describe('radius-catalog', () => {
  const tmp = useTempDataDir(undefined)

  it('is empty and stale before the first fetch', () => {
    expect(getRadiusCatalog()).toBeNull()
    expect(isRadiusCatalogStale()).toBe(true)
    expect(radiusCatalogToAvailableModels()).toEqual([])
  })

  it('fetches, persists and reloads the catalog from disk', async () => {
    loadRadiusGatewayConfig.mockResolvedValue({ baseUrl: sampleCatalog.baseUrl, models: sampleCatalog.models })

    const fetched = await refreshRadiusCatalog({ apiKey: 'tok' })
    expect(loadRadiusGatewayConfig).toHaveBeenCalledWith('https://radius.pi.dev', 'tok', expect.any(AbortSignal))
    expect(fetched.models.map(m => m.id)).toEqual(['kimi-k3', 'glm-5.3'])
    expect(isRadiusCatalogStale()).toBe(false)

    __setRadiusCatalogForTests(undefined)
    expect(getRadiusCatalog()?.models).toHaveLength(2)
    expect(fs.existsSync(path.join(tmp.dir(), 'config', 'radius-catalog.json'))).toBe(true)
  })

  it('reuses a fresh catalog unless forced', async () => {
    __setRadiusCatalogForTests(sampleCatalog)
    await refreshRadiusCatalog()
    expect(loadRadiusGatewayConfig).not.toHaveBeenCalled()

    loadRadiusGatewayConfig.mockResolvedValue({ baseUrl: sampleCatalog.baseUrl, models: [kimi] })
    const forced = await refreshRadiusCatalog({ force: true })
    expect(forced.models).toHaveLength(1)
  })

  it('refetches a stale catalog', async () => {
    __setRadiusCatalogForTests({ ...sampleCatalog, checkedAt: Date.now() - 7 * 60 * 60 * 1000 })
    loadRadiusGatewayConfig.mockResolvedValue({ baseUrl: sampleCatalog.baseUrl, models: [kimi] })
    await refreshRadiusCatalog()
    expect(loadRadiusGatewayConfig).toHaveBeenCalledTimes(1)
  })

  it('does not satisfy an authenticated refresh with an in-flight anonymous fetch', async () => {
    let resolveAnonymous!: (value: { baseUrl: string; models: typeof sampleCatalog.models }) => void
    loadRadiusGatewayConfig
      .mockImplementationOnce(() => new Promise((resolve) => { resolveAnonymous = resolve }))
      .mockResolvedValueOnce({ baseUrl: sampleCatalog.baseUrl, models: sampleCatalog.models })

    const anonymous = refreshRadiusCatalog()
    const authenticated = refreshRadiusCatalog({ apiKey: 'tok', force: true })
    expect(loadRadiusGatewayConfig).toHaveBeenCalledTimes(2)
    expect(loadRadiusGatewayConfig).toHaveBeenLastCalledWith('https://radius.pi.dev', 'tok', expect.any(AbortSignal))

    expect((await authenticated).models).toHaveLength(2)
    resolveAnonymous({ baseUrl: sampleCatalog.baseUrl, models: [kimi] })
    expect((await anonymous).models).toHaveLength(1)
  })

  it('does not let an anonymous refresh overwrite an authenticated catalog', async () => {
    const stale = { ...sampleCatalog, authenticated: true, checkedAt: Date.now() - 7 * 60 * 60 * 1000 }
    __setRadiusCatalogForTests(stale)
    loadRadiusGatewayConfig.mockResolvedValue({ baseUrl: sampleCatalog.baseUrl, models: [kimi] })

    const fetched = await refreshRadiusCatalog()
    expect(fetched.models).toHaveLength(1)
    expect(fetched.authenticated).toBe(false)
    expect(getRadiusCatalog()).toBe(stale)
    expect(fs.existsSync(path.join(tmp.dir(), 'config', 'radius-catalog.json'))).toBe(false)
  })

  it('lets an authenticated refresh replace an anonymous catalog', async () => {
    __setRadiusCatalogForTests({ ...sampleCatalog, authenticated: false })
    loadRadiusGatewayConfig.mockResolvedValue({ baseUrl: sampleCatalog.baseUrl, models: [kimi] })

    await refreshRadiusCatalog({ apiKey: 'tok', force: true })
    expect(getRadiusCatalog()?.authenticated).toBe(true)
    expect(getRadiusCatalog()?.models).toHaveLength(1)
  })

  it('shares one request between concurrent refreshes with the same credential', async () => {
    loadRadiusGatewayConfig.mockResolvedValue({ baseUrl: sampleCatalog.baseUrl, models: [kimi] })
    await Promise.all([refreshRadiusCatalog({ apiKey: 'tok' }), refreshRadiusCatalog({ apiKey: 'tok' })])
    expect(loadRadiusGatewayConfig).toHaveBeenCalledTimes(1)
  })

  it('warns about and ignores a corrupt cache file', () => {
    const dir = path.join(tmp.dir(), 'config')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'radius-catalog.json'), '{not json', 'utf-8')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(getRadiusCatalog()).toBeNull()
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('corrupt Radius catalog cache'))
    } finally {
      warn.mockRestore()
    }
  })

  it('maps catalog entries to sorted AvailableModels', () => {
    __setRadiusCatalogForTests(sampleCatalog)
    expect(radiusCatalogToAvailableModels()).toEqual([
      { id: 'glm-5.3', name: 'GLM 5.3', contextWindow: 1_048_576, cost: { input: 3, output: 15 } },
      { id: 'kimi-k3', name: 'Kimi K3', contextWindow: 1_048_576, cost: { input: 3, output: 15 } },
    ])
  })
})

describe('radius provider presets', () => {
  useTempDataDir(sampleCatalog)

  it('declares both auth variants against the pi-messages gateway', () => {
    expect(PROVIDER_TYPE_PRESETS.radius).toMatchObject({
      apiType: 'pi-messages', providerName: 'radius', baseUrl: RADIUS_BASE_URL,
      authMethod: 'oauth', oauthProviderId: 'radius', dynamicCatalog: true, requiresApiKey: false,
    })
    expect(PROVIDER_TYPE_PRESETS['radius-api-key']).toMatchObject({
      apiType: 'pi-messages', providerName: 'radius', baseUrl: RADIUS_BASE_URL,
      authMethod: 'api-key', dynamicCatalog: true, requiresApiKey: true,
    })
    expect(isRadiusProviderType('radius')).toBe(true)
    expect(isRadiusProviderType('radius-api-key')).toBe(true)
    expect(isRadiusProviderType('openrouter')).toBe(false)
    expect(isDynamicCatalogProvider('radius')).toBe(true)
  })

  it('serves the persisted catalog as the offline model list', () => {
    expect(getAvailableModels('radius').map(m => m.id)).toEqual(['glm-5.3', 'kimi-k3'])
    expect(getAvailableModels('radius-api-key').map(m => m.id)).toEqual(['glm-5.3', 'kimi-k3'])
  })

  it('builds Radius models from the catalog with wire-level metadata', () => {
    const provider = addProvider({ name: 'Radius', providerType: 'radius-api-key', apiKey: 'k', enabledModels: ['kimi-k3'] })
    const model = buildModel(provider, 'kimi-k3')
    expect(model).toMatchObject({
      id: 'kimi-k3',
      name: 'Kimi K3',
      api: 'pi-messages',
      provider: 'radius',
      baseUrl: 'https://radius.pi.dev/v1',
      reasoning: true,
      thinkingLevelMap: kimi.thinkingLevelMap,
      input: ['text', 'image'],
      contextWindow: 1_048_576,
      maxTokens: 131_072,
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
    })
  })

  it('lets per-model user overrides win over catalog display/pricing fields', () => {
    const provider = addProvider({ name: 'Radius', providerType: 'radius-api-key', apiKey: 'k', enabledModels: ['kimi-k3'] })
    const updated = updateProviderModel(provider.id, 'kimi-k3', { name: 'My Kimi', cost: { input: 1 } })
    const model = buildModel(updated, 'kimi-k3')
    expect(model.name).toBe('My Kimi')
    expect(model.cost).toEqual({ input: 1, output: 15, cacheRead: 0.3, cacheWrite: 0 })
    expect(model.maxTokens).toBe(131_072)
  })

  it('falls back to the generic pi-messages build for unknown catalog ids', () => {
    const provider = addProvider({ name: 'Radius', providerType: 'radius-api-key', apiKey: 'k', enabledModels: ['unknown'] })
    const model = buildModel(provider, 'unknown')
    expect(model.api).toBe('pi-messages')
    expect(model.baseUrl).toBe(RADIUS_BASE_URL)
    expect(model.id).toBe('unknown')
  })
})
