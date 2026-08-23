import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createEmailAccount, type ProviderConfig } from '@axiom/core'
import { createRuntimeComposition, loadRuntimeSettings, resolveTaskDefaultProvider } from './runtime-composition.js'

const silentLogger = { log: () => {}, warn: () => {}, error: () => {} }

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

describe('background task tools rebuild on email account change', () => {
  let composition: Awaited<ReturnType<typeof createRuntimeComposition>> | null = null

  beforeEach(() => {
    previousDataDir = process.env.DATA_DIR
    tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-runtime-bg-tools-'))
    process.env.DATA_DIR = tempDataDir
  })

  afterEach(async () => {
    if (composition) {
      await composition.stopBackgroundServices()
      composition = null
    }
    if (previousDataDir === undefined) {
      delete process.env.DATA_DIR
    } else {
      process.env.DATA_DIR = previousDataDir
    }
    fs.rmSync(tempDataDir, { recursive: true, force: true })
  })

  it('adds email tools to the background task tool set after an account change without a restart', async () => {
    composition = await createRuntimeComposition({ logger: silentLogger })

    expect(composition.getBackgroundTaskToolNames()).not.toContain('email_list')

    createEmailAccount({
      name: 'Test',
      imapHost: 'imap.example.com',
      imapPort: 993,
      imapUser: 'user@example.com',
      smtpHost: 'smtp.example.com',
      smtpPort: 465,
      smtpUser: 'user@example.com',
      canSend: true,
    })

    composition.onActiveProviderChanged()

    const toolNames = composition.getBackgroundTaskToolNames()
    expect(toolNames).toContain('email_list')
    expect(toolNames).toContain('email_send')
    expect(toolNames).toContain('create_task')
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
    const reasons: string[] = []
    const result = resolveTaskDefaultProvider(deps({
      taskDefaultProvider: 'p-conf',
      resolveProvider: () => emptyConfigured,
      onFallback: (reason) => reasons.push(reason),
    }))
    expect(result?.id).toBe('p-active')
    expect(result?.enabledModels).toEqual(['active-model'])
    expect(reasons).toEqual(['provider "configured" has no enabled models'])
  })

  it('falls back to the active provider when the configured provider cannot be resolved', () => {
    const reasons: string[] = []
    const result = resolveTaskDefaultProvider(deps({
      taskDefaultProvider: 'missing',
      onFallback: (reason) => reasons.push(reason),
    }))
    expect(result?.id).toBe('p-active')
    expect(result?.enabledModels).toEqual(['active-model'])
    expect(reasons).toEqual(['provider "missing" could not be resolved'])
  })

  it('pins the active model when no task default is configured', () => {
    const reasons: string[] = []
    const result = resolveTaskDefaultProvider(deps({ onFallback: (reason) => reasons.push(reason) }))
    expect(result?.id).toBe('p-active')
    expect(result?.enabledModels).toEqual(['active-model'])
    expect(reasons).toEqual([])
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
