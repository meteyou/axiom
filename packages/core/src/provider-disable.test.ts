import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  getProviderDefaultModel,
  getUsableModels,
  loadProviders,
  resolveProviderModelInput,
  setActiveModel,
  setActiveProvider,
  setFallbackProvider,
  setProviderDisabled,
  setProviderModelDisabled,
  updateProvider,
} from './provider-config.js'
import type { ProviderConfig, ProvidersFile } from './provider-config.js'
import { isDisabledProviderReference, resetDisabledProviderReferences } from './provider-references.js'
import type { ScheduledTask, ScheduledTaskStore, UpdateScheduledTaskInput } from './scheduled-task-store.js'

function provider(id: string, enabledModels: string[], extra: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id,
    name: id.toUpperCase(),
    type: 'openai-completions',
    providerType: 'openai',
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    enabledModels,
    ...extra,
  }
}

let tmpDir: string
const originalDataDir = process.env.DATA_DIR

function writeProviders(file: ProvidersFile): void {
  fs.writeFileSync(path.join(tmpDir, 'config', 'providers.json'), JSON.stringify(file), 'utf-8')
}

function writeSettings(settings: object): void {
  fs.writeFileSync(path.join(tmpDir, 'config', 'settings.json'), JSON.stringify(settings), 'utf-8')
}

interface StoredSettings {
  sessionSummaryProviderId: string
  factExtraction: { providerId: string }
  tasks: { defaultProvider: string }
  stt: { rewrite: { providerId: string } }
  tts: { providerId: string }
}

function readSettings(): StoredSettings {
  return JSON.parse(fs.readFileSync(path.join(tmpDir, 'config', 'settings.json'), 'utf-8')) as StoredSettings
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-provider-disable-'))
  fs.mkdirSync(path.join(tmpDir, 'config'), { recursive: true })
  process.env.DATA_DIR = tmpDir
  writeProviders({
    providers: [provider('a', ['a1', 'a2']), provider('b', ['b1', 'b2'])],
    activeProvider: 'a',
    activeModel: 'a1',
    fallbackProvider: 'b',
    fallbackModel: 'b1',
  })
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  if (originalDataDir !== undefined) process.env.DATA_DIR = originalDataDir
  else delete process.env.DATA_DIR
})

describe('usable model helpers', () => {
  it('skips disabled models and hides everything of a disabled provider', () => {
    expect(getUsableModels(provider('x', ['m1', 'm2'], { disabledModels: ['m1'] }))).toEqual(['m2'])
    expect(getUsableModels(provider('x', ['m1', 'm2'], { disabled: true }))).toEqual([])
  })

  it('uses the first non-disabled model as default and keeps pinned clones working', () => {
    expect(getProviderDefaultModel(provider('x', ['m1', 'm2'], { disabledModels: ['m1'] }))).toBe('m2')
    expect(getProviderDefaultModel(provider('x', ['m1'], { disabledModels: ['m1'] }))).toBe('m1')
  })
})

describe('setProviderDisabled', () => {
  it('rejects disabling the active provider', () => {
    expect(() => setProviderDisabled('a', true)).toThrow(/active provider/)
    expect(loadProviders().providers[0]!.disabled).toBeUndefined()
  })

  it('clears the fallback when its provider gets disabled and re-enables cleanly', () => {
    setProviderDisabled('b', true)
    let file = loadProviders()
    expect(file.providers[1]!.disabled).toBe(true)
    expect(file.fallbackProvider).toBeUndefined()
    expect(file.fallbackModel).toBeUndefined()

    setProviderDisabled('b', false)
    file = loadProviders()
    expect(file.providers[1]!.disabled).toBeUndefined()
  })

  it('blocks selecting a disabled provider as active or fallback', () => {
    setProviderDisabled('b', true)
    expect(() => setActiveProvider('b', 'b1')).toThrow(/disabled/)
    expect(() => setFallbackProvider('b', 'b1')).toThrow(/disabled/)
  })
})

describe('setProviderModelDisabled', () => {
  it('rejects disabling the active model but allows other models of the active provider', () => {
    expect(() => setProviderModelDisabled('a', 'a1', true)).toThrow(/active model/)
    setProviderModelDisabled('a', 'a2', true)
    expect(loadProviders().providers[0]!.disabledModels).toEqual(['a2'])
    expect(() => setActiveModel('a2')).toThrow(/disabled/)
  })

  it('clears the fallback only when the fallback model itself gets disabled', () => {
    setProviderModelDisabled('b', 'b2', true)
    expect(loadProviders().fallbackModel).toBe('b1')

    setProviderModelDisabled('b', 'b1', true)
    const file = loadProviders()
    expect(file.fallbackProvider).toBeUndefined()
    expect(file.providers[1]!.disabledModels).toEqual(['b1', 'b2'])
  })

  it('rejects unknown models and drops the disabled marker when a model is removed', () => {
    expect(() => setProviderModelDisabled('b', 'nope', true)).toThrow(/not configured/)

    setProviderModelDisabled('b', 'b2', true)
    updateProvider('b', { enabledModels: ['b1'] })
    expect(loadProviders().providers[1]!.disabledModels).toBeUndefined()
  })
})

describe('resolveProviderModelInput', () => {
  it('does not resolve disabled providers or models', () => {
    setProviderModelDisabled('b', 'b2', true)
    expect(resolveProviderModelInput({ model: 'b2' }).ok).toBe(false)
    expect(resolveProviderModelInput({ provider: 'b', model: 'b2' }).ok).toBe(false)
    expect(resolveProviderModelInput({ provider: 'b' })).toMatchObject({ ok: true, modelId: 'b1' })

    setProviderDisabled('b', true)
    expect(resolveProviderModelInput({ provider: 'b' }).ok).toBe(false)
  })
})

describe('resetDisabledProviderReferences', () => {
  function fakeStore(jobs: Array<Pick<ScheduledTask, 'id' | 'provider'>>) {
    const updates: Array<{ id: string; input: UpdateScheduledTaskInput }> = []
    const store = {
      list: () => jobs as ScheduledTask[],
      update: (id: string, input: UpdateScheduledTaskInput) => {
        updates.push({ id, input })
        return null
      },
    } as unknown as ScheduledTaskStore
    return { store, updates }
  }

  it('resets LLM settings and cronjobs that point at disabled providers/models, leaving STT/TTS alone', () => {
    writeSettings({
      sessionSummaryProviderId: 'b:b2',
      factExtraction: { providerId: 'b:b1' },
      memoryConsolidation: { providerId: 'a:a1' },
      tasks: { defaultProvider: 'b', loopDetection: { smartProvider: 'b:b2' } },
      stt: { rewrite: { providerId: 'b:b2' } },
      tts: { providerId: 'b' },
    })
    setProviderModelDisabled('b', 'b2', true)
    const { store, updates } = fakeStore([
      { id: 'job-disabled', provider: 'b:b2' },
      { id: 'job-ok', provider: 'b:b1' },
      { id: 'job-default', provider: null },
    ])

    const result = resetDisabledProviderReferences({ scheduledTaskStore: store })

    expect(result.settingsPaths).toEqual(['sessionSummaryProviderId', 'tasks.loopDetection.smartProvider'])
    expect(result.cronjobIds).toEqual(['job-disabled'])
    expect(updates).toEqual([{ id: 'job-disabled', input: { provider: '' } }])
    const settings = readSettings()
    expect(settings.sessionSummaryProviderId).toBe('')
    expect(settings.factExtraction.providerId).toBe('b:b1')
    expect(settings.tasks.defaultProvider).toBe('b')
    expect(settings.stt.rewrite.providerId).toBe('b:b2')
    expect(settings.tts.providerId).toBe('b')
  })

  it('resets the default image model once its provider is disabled', () => {
    writeSettings({ imageGeneration: { defaultModel: 'b:recraft/recraft-v4.1' } })
    setProviderDisabled('b', true)

    expect(resetDisabledProviderReferences().settingsPaths).toEqual(['imageGeneration.defaultModel'])
    expect((readSettings() as unknown as { imageGeneration: { defaultModel: string } }).imageGeneration.defaultModel).toBe('')
  })

  it('treats provider-only references as disabled once the whole provider is disabled', () => {
    const { providers } = loadProviders()
    const disabled = providers.map(p => (p.id === 'b' ? { ...p, disabled: true } : p))
    expect(isDisabledProviderReference('b', disabled)).toBe(true)
    expect(isDisabledProviderReference('B:b1', disabled)).toBe(true)
    expect(isDisabledProviderReference('a:a1', disabled)).toBe(false)
    expect(isDisabledProviderReference('unknown:x', disabled)).toBe(false)
    expect(isDisabledProviderReference('', disabled)).toBe(false)
  })
})
