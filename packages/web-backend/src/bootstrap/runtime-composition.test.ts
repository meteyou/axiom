import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ProviderConfig } from '@axiom/core'
import { loadRuntimeSettings, resolveTaskDefaultProvider } from './runtime-composition.js'

function makeProvider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'p-active',
    name: 'active',
    type: 'openai-completions',
    providerType: 'openai',
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-test',
    enabledModels: ['active-model'],
    ...overrides,
  }
}

let tempDataDir: string
let previousDataDir: string | undefined

function writeSettings(settings: unknown) {
  const configDir = path.join(tempDataDir, 'config')
  fs.mkdirSync(configDir, { recursive: true })
  fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify(settings, null, 2))
}

describe('runtime composition settings', () => {
  beforeEach(() => {
    previousDataDir = process.env.DATA_DIR
    tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-runtime-settings-'))
    process.env.DATA_DIR = tempDataDir
  })

  afterEach(() => {
    if (previousDataDir === undefined) {
      delete process.env.DATA_DIR
    } else {
      process.env.DATA_DIR = previousDataDir
    }
    fs.rmSync(tempDataDir, { recursive: true, force: true })
  })

  it('reloads task defaults from settings.json on each call', () => {
    writeSettings({ tasks: { defaultProvider: 'openai-oauth:gpt-5.3-codex' } })
    expect(loadRuntimeSettings().taskSettings.defaultProvider).toBe('openai-oauth:gpt-5.3-codex')

    writeSettings({ tasks: { defaultProvider: 'openai-oauth:gpt-5.5' } })
    expect(loadRuntimeSettings().taskSettings.defaultProvider).toBe('openai-oauth:gpt-5.5')
  })

  it('falls back to an empty task default when settings no longer define one', () => {
    writeSettings({ tasks: { defaultProvider: 'openai-oauth:gpt-5.3-codex' } })
    expect(loadRuntimeSettings().taskSettings.defaultProvider).toBe('openai-oauth:gpt-5.3-codex')

    writeSettings({ tasks: {} })
    expect(loadRuntimeSettings().taskSettings.defaultProvider).toBe('')
  })
})

describe('resolveTaskDefaultProvider', () => {
  const active = makeProvider({ id: 'p-active', name: 'active', enabledModels: ['active-model'] })
  const configured = makeProvider({ id: 'p-conf', name: 'configured', enabledModels: ['conf-model'] })

  function deps(over: Partial<Parameters<typeof resolveTaskDefaultProvider>[0]> = {}) {
    return {
      taskDefaultProvider: '',
      resolveProvider: (id: string) => (id === configured.id ? configured : null),
      getActiveProvider: () => active,
      getActiveModelId: () => 'active-model',
      ...over,
    }
  }

  it('pins the requested model when the task default specifies provider and model', () => {
    const result = resolveTaskDefaultProvider(deps({ taskDefaultProvider: 'p-conf:conf-model-2' }))
    expect(result?.id).toBe('p-conf')
    expect(result?.enabledModels).toEqual(['conf-model-2'])
  })

  it('returns the configured provider unchanged when it has enabled models and no model is pinned', () => {
    const result = resolveTaskDefaultProvider(deps({ taskDefaultProvider: 'p-conf' }))
    expect(result).toBe(configured)
  })

  it('falls back to the active provider when the configured provider has no enabled models', () => {
    const emptyConfigured = makeProvider({ id: 'p-conf', name: 'configured', enabledModels: [] })
    const result = resolveTaskDefaultProvider(deps({
      taskDefaultProvider: 'p-conf',
      resolveProvider: () => emptyConfigured,
    }))
    expect(result?.id).toBe('p-active')
    expect(result?.enabledModels).toEqual(['active-model'])
  })

  it('falls back to the active provider when the configured provider cannot be resolved', () => {
    const result = resolveTaskDefaultProvider(deps({ taskDefaultProvider: 'missing' }))
    expect(result?.id).toBe('p-active')
    expect(result?.enabledModels).toEqual(['active-model'])
  })

  it('pins the active model when no task default is configured', () => {
    const result = resolveTaskDefaultProvider(deps())
    expect(result?.id).toBe('p-active')
    expect(result?.enabledModels).toEqual(['active-model'])
  })

  it('returns the active provider unchanged when no active model is selected', () => {
    const result = resolveTaskDefaultProvider(deps({ getActiveModelId: () => null }))
    expect(result).toBe(active)
  })

  it('returns null when there is no active provider to fall back to', () => {
    const result = resolveTaskDefaultProvider(deps({ getActiveProvider: () => null }))
    expect(result).toBeNull()
  })
})
