import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createEmailAccount } from '@axiom/core'
import { createRuntimeComposition, loadRuntimeSettings } from './runtime-composition.js'

const silentLogger = { log: () => {}, warn: () => {}, error: () => {} }

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

    // No account yet: createEmailTools() returns [], so the background set has
    // no email tools.
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

    // Simulate the /api/email hook firing on an account change. The task runner
    // captured the backgroundTaskTools array reference at boot, so this must
    // update that same array in place rather than swap it out.
    composition.onActiveProviderChanged()

    const toolNames = composition.getBackgroundTaskToolNames()
    expect(toolNames).toContain('email_list')
    expect(toolNames).toContain('email_send')
    // Task tools must survive the in-place rebuild.
    expect(toolNames).toContain('create_task')
  })
})
