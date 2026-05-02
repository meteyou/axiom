import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  parseSlashCommand,
  SlashCommandRegistry,
  registerBuiltInSlashCommands,
  formatTasksReply,
  formatCronjobsReply,
  renderHelp,
} from './slash-commands.js'

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

  it('registers help / tasks / cronjobs / settings on both surfaces', () => {
    const names = registry.list('web').map((c) => c.name)
    expect(names).toContain('help')
    expect(names).toContain('tasks')
    expect(names).toContain('cronjobs')
    expect(names).toContain('settings')
    expect(registry.list('telegram').map((c) => c.name)).toEqual(names)
  })

  it('/help renders all commands for the surface', async () => {
    const r = await registry.dispatch('/help', { surface: 'web', userId: '1', registry })
    expect(r.kind).toBe('handled')
    if (r.kind === 'handled') {
      expect(r.reply).toContain('/help')
      expect(r.reply).toContain('/tasks')
      expect(r.reply).toContain('/settings')
    }
  })

  it('/tasks falls back gracefully without a task store', async () => {
    const r = await registry.dispatch('/tasks', { surface: 'web', userId: '1', registry })
    expect(r.kind).toBe('handled')
    if (r.kind === 'handled') expect(r.reply).toMatch(/not available/)
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
      expect(r.reply).toContain('Running tasks: 1')
      expect(r.reply).toContain('do thing')
      expect(r.reply).toContain('[completed]')
      expect(r.reply).toContain('old thing')
    }
    expect(taskStore.list).toHaveBeenCalledTimes(2)
  })

  it('/cronjobs falls back gracefully without a store', async () => {
    const r = await registry.dispatch('/cronjobs', { surface: 'web', userId: '1', registry })
    expect(r.kind).toBe('handled')
    if (r.kind === 'handled') expect(r.reply).toMatch(/not available/)
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
})
