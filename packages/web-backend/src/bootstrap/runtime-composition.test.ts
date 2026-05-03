import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadRuntimeSettings } from './runtime-composition.js'

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
