import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  parseSlashCommand,
  SlashCommandRegistry,
  registerBuiltInSlashCommands,
  formatTasksReply,
  formatCronjobsReply,
  renderHelp,
  isSlashCommandPicker,
} from './slash-commands.js'
import type { SlashCommandPicker, SlashCommandReply } from './slash-commands.js'

function asText(reply: SlashCommandReply): string {
  expect(typeof reply).toBe('string')
  return reply as string
}

function asPicker(reply: SlashCommandReply): SlashCommandPicker {
  expect(isSlashCommandPicker(reply)).toBe(true)
  return reply as SlashCommandPicker
}

describe('parseSlashCommand', () => {
  it('parses a bare command', () => {
    expect(parseSlashCommand('/help')).toEqual({ raw: '/help', name: 'help', args: '' })
  })

  it('lowercases the command name but preserves args', () => {
    expect(parseSlashCommand('/HELP world')).toEqual({ raw: '/HELP world', name: 'help', args: 'world' })
  })

  it('strips a Telegram @botname suffix', () => {
    expect(parseSlashCommand('/help@my_bot extra')).toEqual({
      raw: '/help@my_bot extra',
      name: 'help',
      args: 'extra',
    })
  })

  it('treats double-slash as literal text, not a command', () => {
    expect(parseSlashCommand('//help')).toBeNull()
  })

  it('rejects input that does not start with a slash', () => {
    expect(parseSlashCommand('help')).toBeNull()
    expect(parseSlashCommand(' /help')).toBeNull()
  })

  it('rejects an empty slash', () => {
    expect(parseSlashCommand('/')).toBeNull()
  })

  it('rejects names with invalid characters', () => {
    expect(parseSlashCommand('/foo-bar')).toBeNull()
    expect(parseSlashCommand('/foo!')).toBeNull()
  })

  it('captures multi-word args trimmed', () => {
    expect(parseSlashCommand('/title  hello  world  ')).toEqual({
      raw: '/title  hello  world  ',
      name: 'title',
      args: 'hello  world',
    })
  })
})

describe('SlashCommandRegistry', () => {
  let registry: SlashCommandRegistry

  beforeEach(() => {
    registry = new SlashCommandRegistry()
  })

  it('registers and resolves by name', () => {
    registry.register({ name: 'foo', description: 'foo cmd', surfaces: ['web'], handler: () => 'foo!' })
    expect(registry.resolve('foo')?.description).toBe('foo cmd')
    expect(registry.resolve('FOO')?.name).toBe('foo')
  })

  it('resolves by alias', () => {
    registry.register({
      name: 'help',
      aliases: ['hh', 'h'],
      description: 'help',
      surfaces: ['web'],
      handler: () => 'h',
    })
    expect(registry.resolve('hh')?.name).toBe('help')
    expect(registry.resolve('H')?.name).toBe('help')
  })

  it('rejects duplicate names and conflicting aliases', () => {
    registry.register({ name: 'a', description: 'a', surfaces: ['web'] })
    expect(() => registry.register({ name: 'a', description: 'a2', surfaces: ['web'] })).toThrow(/already registered/)
    expect(() =>
      registry.register({ name: 'b', aliases: ['a'], description: 'b', surfaces: ['web'] }),
    ).toThrow(/collides|conflicts/)
  })

  it('list() filters by surface', () => {
    registry.register({ name: 'web1', description: 'w', surfaces: ['web'] })
    registry.register({ name: 'tg1', description: 't', surfaces: ['telegram'] })
    registry.register({ name: 'both', description: 'b', surfaces: ['web', 'telegram'] })
    expect(registry.list('web').map((c) => c.name)).toEqual(['both', 'web1'])
    expect(registry.list('telegram').map((c) => c.name)).toEqual(['both', 'tg1'])
  })

  it('dispatch returns no_command for non-slash input', async () => {
    const r = await registry.dispatch('hello world', { surface: 'web', userId: '1', registry })
    expect(r.kind).toBe('no_command')
  })

  it('dispatch returns not_found for unknown command', async () => {
    const r = await registry.dispatch('/nope', { surface: 'web', userId: '1', registry })
    expect(r).toEqual({ kind: 'not_found', name: 'nope' })
  })

  it('dispatch returns wrong_surface when a known command is invoked from the wrong surface', async () => {
    registry.register({ name: 'tgonly', description: 'tg', surfaces: ['telegram'], handler: () => 'tg' })
    const r = await registry.dispatch('/tgonly', { surface: 'web', userId: '1', registry })
    expect(r.kind).toBe('wrong_surface')
  })

  it('dispatch returns external for metadata-only entries', async () => {
    registry.register({ name: 'new', description: 'new session', surfaces: ['web', 'telegram'] })
    const r = await registry.dispatch('/new now', { surface: 'web', userId: '1', registry })
    expect(r.kind).toBe('external')
    if (r.kind === 'external') {
      expect(r.command.name).toBe('new')
      expect(r.args).toBe('now')
    }
  })

  it('dispatch invokes the handler and returns its reply', async () => {
    registry.register({
      name: 'echo',
      description: 'echo',
      surfaces: ['web'],
      handler: (ctx) => `you said: ${ctx.args}`,
    })
    const r = await registry.dispatch('/echo hello', { surface: 'web', userId: '1', registry })
    expect(r).toMatchObject({ kind: 'handled' })
    if (r.kind === 'handled') expect(r.reply).toBe('you said: hello')
  })

  it('dispatch catches handler errors and returns a friendly reply', async () => {
    registry.register({
      name: 'boom',
      description: 'boom',
      surfaces: ['web'],
      handler: () => {
        throw new Error('kaboom')
      },
    })
    const r = await registry.dispatch('/boom', { surface: 'web', userId: '1', registry })
    expect(r.kind).toBe('handled')
    if (r.kind === 'handled') expect(r.reply).toContain('kaboom')
  })
})

describe('built-in slash commands', () => {
  let registry: SlashCommandRegistry

  beforeEach(() => {
    registry = new SlashCommandRegistry()
    registerBuiltInSlashCommands(registry)
  })

  it('registers help / tasks / cronjobs / model on both surfaces', () => {
    const names = registry.list('web').map((c) => c.name)
    expect(names).toContain('help')
    expect(names).toContain('tasks')
    expect(names).toContain('cronjobs')
    expect(names).toContain('model')
    expect(names).toContain('thinking')
    expect(registry.list('telegram').map((c) => c.name)).toEqual(names)
  })

  it('exposes /provider as an alias of /model and does not register /settings', () => {
    expect(registry.resolve('provider')?.name).toBe('model')
    expect(registry.resolve('model')?.name).toBe('model')
    expect(registry.resolve('settings')).toBeUndefined()
  })

  it('/help renders all commands for the surface', async () => {
    const r = await registry.dispatch('/help', { surface: 'web', userId: '1', registry })
    expect(r.kind).toBe('handled')
    if (r.kind === 'handled') {
      const text = asText(r.reply)
      expect(text).toContain('/help')
      expect(text).toContain('/tasks')
      expect(text).toContain('/model')
      expect(text).not.toContain('/settings')
    }
  })

  it('/thinking shows and updates the configured thinking level', async () => {
    const previousDataDir = process.env.DATA_DIR
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-thinking-command-'))
    process.env.DATA_DIR = dataDir
    try {
      fs.mkdirSync(path.join(dataDir, 'config'), { recursive: true })
      fs.writeFileSync(
        path.join(dataDir, 'config', 'settings.json'),
        `${JSON.stringify({ thinkingLevel: 'off' }, null, 2)}\n`,
        'utf-8',
      )

      const onThinkingLevelChanged = vi.fn()
      const show = await registry.dispatch('/thinking', { surface: 'web', userId: '1', registry })
      expect(show.kind).toBe('handled')
      if (show.kind === 'handled') expect(asText(show.reply)).toContain('Current thinking level: off')

      const set = await registry.dispatch('/thinking medium', {
        surface: 'web',
        userId: '1',
        registry,
        onThinkingLevelChanged,
      })
      expect(set.kind).toBe('handled')
      if (set.kind === 'handled') expect(asText(set.reply)).toBe('Thinking level set to: medium')
      expect(onThinkingLevelChanged).toHaveBeenCalledWith('medium')
      expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'config', 'settings.json'), 'utf-8')).thinkingLevel).toBe('medium')
    } finally {
      if (previousDataDir === undefined) delete process.env.DATA_DIR
      else process.env.DATA_DIR = previousDataDir
      fs.rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('/thinking rejects invalid levels', async () => {
    const r = await registry.dispatch('/thinking extreme', { surface: 'web', userId: '1', registry })
    expect(r.kind).toBe('handled')
    if (r.kind === 'handled') expect(asText(r.reply)).toContain('Unknown thinking level: extreme')
  })

  it('/tasks falls back gracefully without a task store', async () => {
    const r = await registry.dispatch('/tasks', { surface: 'web', userId: '1', registry })
    expect(r.kind).toBe('handled')
    if (r.kind === 'handled') expect(asText(r.reply)).toMatch(/not available/)
  })

  it('/tasks renders running and recent tasks', async () => {
    const taskStore = {
      list: vi.fn((filters?: { status?: string; limit?: number }) => {
        if (filters?.status === 'running') {
          return [
            {
              id: '1',
              name: 'do thing',
              status: 'running',
              triggerType: 'user',
              createdAt: '2024-01-01 10:00:00',
            },
          ]
        }
        return [
          {
            id: '2',
            name: 'old thing',
            status: 'completed',
            triggerType: 'agent',
            createdAt: '2024-01-01 09:00:00',
            finishedAt: '2024-01-01 09:05:00',
          },
        ]
      }),
    }
    const r = await registry.dispatch('/tasks', {
      surface: 'web',
      userId: '1',
      registry,
      taskStore: taskStore as never,
    })
    expect(r.kind).toBe('handled')
    if (r.kind === 'handled') {
      const text = asText(r.reply)
      expect(text).toContain('Running tasks: 1')
      expect(text).toContain('do thing')
      expect(text).toContain('[completed]')
      expect(text).toContain('old thing')
    }
    expect(taskStore.list).toHaveBeenCalledTimes(2)
  })

  it('/cronjobs falls back gracefully without a store', async () => {
    const r = await registry.dispatch('/cronjobs', { surface: 'web', userId: '1', registry })
    expect(r.kind).toBe('handled')
    if (r.kind === 'handled') expect(asText(r.reply)).toMatch(/not available/)
  })

  it('/cronjobs renders enabled state and next run', async () => {
    const reply = formatCronjobsReply([
      { id: 'a', name: 'morning', cronExpression: '0 9 * * *', enabled: true, nextRunAt: '2024-01-02 09:00' },
      { id: 'b', name: 'paused', cronExpression: '0 0 * * *', enabled: false },
    ])
    expect(reply).toContain('morning')
    expect(reply).toContain('[on ]')
    expect(reply).toContain('[off]')
    expect(reply).toContain('next: 2024-01-02 09:00')
  })

  it('formatTasksReply handles empty input', () => {
    expect(formatTasksReply([], [])).toContain('Running tasks: 0')
    expect(formatTasksReply([], [])).toContain('(none)')
  })

  it('renderHelp returns a helpful message for empty surfaces', () => {
    const empty = new SlashCommandRegistry()
    expect(renderHelp(empty, 'web')).toMatch(/No slash commands/)
  })

  describe('/model', () => {
    let dataDir: string
    let previousDataDir: string | undefined

    function writeProviders(providers: unknown): void {
      fs.mkdirSync(path.join(dataDir, 'config'), { recursive: true })
      fs.writeFileSync(
        path.join(dataDir, 'config', 'providers.json'),
        `${JSON.stringify(providers, null, 2)}\n`,
        'utf-8',
      )
    }

    beforeEach(() => {
      previousDataDir = process.env.DATA_DIR
      dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-model-command-'))
      process.env.DATA_DIR = dataDir
    })

    afterEach(() => {
      if (previousDataDir === undefined) delete process.env.DATA_DIR
      else process.env.DATA_DIR = previousDataDir
      fs.rmSync(dataDir, { recursive: true, force: true })
    })

    it('reports when no providers are configured', async () => {
      writeProviders({ providers: [] })
      const r = await registry.dispatch('/model', { surface: 'web', userId: '1', registry })
      expect(r.kind).toBe('handled')
      if (r.kind === 'handled') expect(asText(r.reply)).toMatch(/No providers are configured/)
    })

    it('returns a provider picker with no args', async () => {
      writeProviders({
        activeProvider: 'p1',
        activeModel: 'gpt-4o',
        providers: [
          {
            id: 'p1', name: 'OpenAI', type: 'openai-completions', providerType: 'openai',
            provider: 'openai', baseUrl: 'https://api.openai.com', apiKey: '',
            defaultModel: 'gpt-4o', enabledModels: ['gpt-4o', 'gpt-4o-mini'],
          },
          {
            id: 'p2', name: 'Anthropic', type: 'anthropic-messages', providerType: 'anthropic',
            provider: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: '',
            defaultModel: 'claude-sonnet-4-20250514',
          },
        ],
      })
      const r = await registry.dispatch('/model', { surface: 'web', userId: '1', registry })
      expect(r.kind).toBe('handled')
      if (r.kind !== 'handled') return
      const picker = asPicker(r.reply)
      expect(picker.pickerId).toBe('model:providers')
      expect(picker.options).toHaveLength(2)
      expect(picker.options[0]).toMatchObject({ command: '/model p1', label: 'OpenAI', badge: 'active' })
      expect(picker.options[1]).toMatchObject({ command: '/model p2', label: 'Anthropic' })
      expect(picker.description).toContain('OpenAI')
      expect(picker.description).toContain('gpt-4o')
    })

    it('also exposes the picker via the /provider alias', async () => {
      writeProviders({
        activeProvider: 'p1',
        providers: [{
          id: 'p1', name: 'OpenAI', type: 'openai-completions', providerType: 'openai',
          provider: 'openai', baseUrl: '', apiKey: '', defaultModel: 'gpt-4o',
        }],
      })
      const r = await registry.dispatch('/provider', { surface: 'web', userId: '1', registry })
      expect(r.kind).toBe('handled')
      if (r.kind !== 'handled') return
      expect(asPicker(r.reply).pickerId).toBe('model:providers')
    })

    it('returns a model picker with active/default badges and a back button', async () => {
      writeProviders({
        activeProvider: 'p1',
        activeModel: 'gpt-4o-mini',
        providers: [{
          id: 'p1', name: 'OpenAI', type: 'openai-completions', providerType: 'openai',
          provider: 'openai', baseUrl: '', apiKey: '',
          defaultModel: 'gpt-4o', enabledModels: ['gpt-4o', 'gpt-4o-mini'],
        }],
      })
      const r = await registry.dispatch('/model p1', { surface: 'web', userId: '1', registry })
      expect(r.kind).toBe('handled')
      if (r.kind !== 'handled') return
      const picker = asPicker(r.reply)
      expect(picker.pickerId).toBe('model:models:p1')
      // gpt-4o, gpt-4o-mini, plus a back button
      expect(picker.options).toHaveLength(3)
      const byCmd = Object.fromEntries(picker.options.map((o) => [o.command, o]))
      expect(byCmd['/model p1 gpt-4o']?.badge).toBe('default')
      expect(byCmd['/model p1 gpt-4o-mini']?.badge).toBe('active')
      // Back button is last
      expect(picker.options[picker.options.length - 1]).toMatchObject({
        command: '/model',
        label: expect.stringMatching(/back/i),
      })
    })

    it('resolves provider also by name (case-insensitive)', async () => {
      writeProviders({
        activeProvider: 'p1',
        providers: [{
          id: 'p1', name: 'OpenAI', type: 'openai-completions', providerType: 'openai',
          provider: 'openai', baseUrl: '', apiKey: '',
          defaultModel: 'gpt-4o', enabledModels: ['gpt-4o'],
        }],
      })
      const r = await registry.dispatch('/model openai', { surface: 'web', userId: '1', registry })
      expect(r.kind).toBe('handled')
      if (r.kind !== 'handled') return
      expect(asPicker(r.reply).pickerId).toBe('model:models:p1')
    })

    it('rejects unknown providers with a hint to use /model', async () => {
      writeProviders({
        activeProvider: 'p1',
        providers: [{
          id: 'p1', name: 'OpenAI', type: 'openai-completions', providerType: 'openai',
          provider: 'openai', baseUrl: '', apiKey: '', defaultModel: 'gpt-4o',
        }],
      })
      const r = await registry.dispatch('/model nope', { surface: 'web', userId: '1', registry })
      expect(r.kind).toBe('handled')
      if (r.kind !== 'handled') return
      const text = asText(r.reply)
      expect(text).toContain('Unknown provider: nope')
      expect(text).toContain('/model')
    })

    it('switches active provider and model when both are valid', async () => {
      writeProviders({
        activeProvider: 'p1',
        activeModel: 'gpt-4o',
        providers: [
          {
            id: 'p1', name: 'OpenAI', type: 'openai-completions', providerType: 'openai',
            provider: 'openai', baseUrl: '', apiKey: '', defaultModel: 'gpt-4o',
            enabledModels: ['gpt-4o', 'gpt-4o-mini'],
          },
          {
            id: 'p2', name: 'Anthropic', type: 'anthropic-messages', providerType: 'anthropic',
            provider: 'anthropic', baseUrl: '', apiKey: '',
            defaultModel: 'claude-sonnet-4-20250514',
            enabledModels: ['claude-sonnet-4-20250514', 'claude-3-5-sonnet-20241022'],
          },
        ],
      })
      const r = await registry.dispatch(
        '/model p2 claude-3-5-sonnet-20241022',
        { surface: 'web', userId: '1', registry },
      )
      expect(r.kind).toBe('handled')
      if (r.kind !== 'handled') return
      const text = asText(r.reply)
      expect(text).toContain('Active provider: Anthropic')
      expect(text).toContain('Active model: claude-3-5-sonnet-20241022')
      const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'config', 'providers.json'), 'utf-8'))
      expect(stored.activeProvider).toBe('p2')
      expect(stored.activeModel).toBe('claude-3-5-sonnet-20241022')
    })

    it('rejects models that are not enabled for the provider', async () => {
      writeProviders({
        activeProvider: 'p1',
        providers: [{
          id: 'p1', name: 'OpenAI', type: 'openai-completions', providerType: 'openai',
          provider: 'openai', baseUrl: '', apiKey: '', defaultModel: 'gpt-4o',
          enabledModels: ['gpt-4o'],
        }],
      })
      const r = await registry.dispatch('/model p1 gpt-3.5-turbo', { surface: 'web', userId: '1', registry })
      expect(r.kind).toBe('handled')
      if (r.kind !== 'handled') return
      expect(asText(r.reply)).toContain('not enabled')
    })
  })
})
