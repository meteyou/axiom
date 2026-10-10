import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import { resolveUserScope } from './user-scope.js'
import { SlashCommandRegistry, registerBuiltInSlashCommands } from './slash-commands.js'
import {
  getUserSettingsOverrides,
  listSelectableChatModels,
  toSttLanguage,
  updateUserSettings,
} from './user-settings.js'

describe('user-settings', () => {
  let db: Database
  let dataDir: string
  let previousDataDir: string | undefined
  let admin: number
  let bob: number
  let carol: number

  function writeConfig(name: string, content: unknown): void {
    fs.mkdirSync(path.join(dataDir, 'config'), { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'config', name), JSON.stringify(content), 'utf-8')
  }

  function addUser(username: string, role: string): number {
    return Number(db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(username, 'h', role).lastInsertRowid)
  }

  beforeEach(() => {
    previousDataDir = process.env.DATA_DIR
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-user-settings-'))
    process.env.DATA_DIR = dataDir
    writeConfig('settings.json', { thinkingLevel: 'low', language: 'German', timezone: 'UTC' })
    writeConfig('providers.json', {
      activeProvider: 'p1',
      activeModel: 'm1',
      providers: [
        { id: 'p1', name: 'One', providerType: 'openai', apiKey: 'secret', enabledModels: ['m1', 'm2'], disabledModels: ['m2'] },
        { id: 'p2', name: 'Two', providerType: 'anthropic', apiKey: 'secret', enabledModels: ['m3'] },
        { id: 'p3', name: 'Off', providerType: 'openai', apiKey: 'secret', enabledModels: ['m4'], disabled: true },
      ],
    })
    db = initDatabase(':memory:')
    admin = addUser('admin', 'admin')
    bob = addUser('bob', 'user')
    carol = addUser('carol', 'user')
  })

  afterEach(() => {
    if (previousDataDir === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDir
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it('resolves defaults for users without overrides and follows later global changes', () => {
    expect(resolveUserScope(db, bob)?.settings).toEqual({ chatModel: null, thinkingLevel: 'low', language: 'German', timezone: 'UTC' })
    writeConfig('settings.json', { thinkingLevel: 'high', language: 'French', timezone: 'UTC' })
    expect(resolveUserScope(db, bob)?.settings).toEqual({ chatModel: null, thinkingLevel: 'high', language: 'French', timezone: 'UTC' })
  })

  it('applies an override only to its user', () => {
    updateUserSettings(db, bob, { thinkingLevel: 'high', language: 'Spanish', chatModel: { providerId: 'p2', modelId: 'm3' } })
    expect(resolveUserScope(db, bob)?.settings).toEqual({
      chatModel: { providerId: 'p2', modelId: 'm3' },
      thinkingLevel: 'high',
      language: 'Spanish',
      timezone: 'UTC',
    })
    expect(resolveUserScope(db, carol)?.settings.thinkingLevel).toBe('low')

    updateUserSettings(db, bob, { thinkingLevel: null })
    expect(getUserSettingsOverrides(db, bob).thinkingLevel).toBeNull()
    expect(getUserSettingsOverrides(db, bob).language).toBe('Spanish')
  })

  it('falls back to the default model when the own model is no longer usable', () => {
    updateUserSettings(db, bob, { chatModel: { providerId: 'p1', modelId: 'm2' } })
    expect(resolveUserScope(db, bob)?.settings.chatModel).toBeNull()
    updateUserSettings(db, bob, { chatModel: { providerId: 'gone', modelId: 'm1' } })
    expect(resolveUserScope(db, bob)?.settings.chatModel).toBeNull()
    expect(getUserSettingsOverrides(db, bob).chatModel).toEqual({ providerId: 'gone', modelId: 'm1' })
  })

  it('gives admins the global settings regardless of stored overrides', () => {
    updateUserSettings(db, admin, { thinkingLevel: 'high' })
    expect(resolveUserScope(db, admin)?.settings.thinkingLevel).toBe('low')
  })

  it('lists selectable models without credentials', () => {
    const list = listSelectableChatModels()
    expect(list.map(p => p.id)).toEqual(['p1', 'p2'])
    expect(list[0]!.models).toEqual([{ id: 'm1', name: 'm1' }])
    expect(JSON.stringify(list)).not.toContain('secret')
  })

  it('maps automatic languages to no STT language', () => {
    expect(toSttLanguage('match')).toBeUndefined()
    expect(toSttLanguage('')).toBeUndefined()
    expect(toSttLanguage('de')).toBe('de')
  })

  describe('slash commands', () => {
    const registry = new SlashCommandRegistry()
    registerBuiltInSlashCommands(registry)

    async function run(input: string, userId: number | string): Promise<string> {
      const r = await registry.dispatch(input, { surface: 'web', userId: String(userId), registry, db })
      if (r.kind !== 'handled') throw new Error('not handled')
      return typeof r.reply === 'string' ? r.reply : ''
    }

    it('/thinking from a regular user changes only their own setting', async () => {
      expect(await run('/thinking high', bob)).toBe('Thinking level set to: high')
      expect(resolveUserScope(db, bob)?.settings.thinkingLevel).toBe('high')
      expect(resolveUserScope(db, carol)?.settings.thinkingLevel).toBe('low')
      expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'config', 'settings.json'), 'utf-8')).thinkingLevel).toBe('low')

      await run('/thinking default', bob)
      expect(resolveUserScope(db, bob)?.settings.thinkingLevel).toBe('low')
    })

    it('/thinking from an admin changes the global setting', async () => {
      await run('/thinking high', admin)
      expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'config', 'settings.json'), 'utf-8')).thinkingLevel).toBe('high')
      expect(resolveUserScope(db, bob)?.settings.thinkingLevel).toBe('high')
    })

    it('/model from a regular user changes only their own model', async () => {
      await run('/model p2 m3', bob)
      expect(resolveUserScope(db, bob)?.settings.chatModel).toEqual({ providerId: 'p2', modelId: 'm3' })
      expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'config', 'providers.json'), 'utf-8')).activeProvider).toBe('p1')

      await run('/model default', bob)
      expect(resolveUserScope(db, bob)?.settings.chatModel).toBeNull()
    })

    it('/model from an admin changes the global model', async () => {
      await run('/model p2 m3', admin)
      expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'config', 'providers.json'), 'utf-8')).activeProvider).toBe('p2')
      expect(getUserSettingsOverrides(db, admin).chatModel).toBeNull()
    })

    it('/model and /thinking from an identity without a user row change nothing', async () => {
      expect(await run('/thinking', 'telegram-42')).toContain('Current thinking level: low')
      expect(await run('/thinking high', 'telegram-42')).toContain('Link this account')
      expect(await run('/model', 'telegram-42')).toContain('Current model: One / m1')
      expect(await run('/model p2 m3', 'telegram-42')).toContain('Link this account')
      expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'config', 'settings.json'), 'utf-8')).thinkingLevel).toBe('low')
      expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'config', 'providers.json'), 'utf-8')).activeProvider).toBe('p1')
    })
  })
})
