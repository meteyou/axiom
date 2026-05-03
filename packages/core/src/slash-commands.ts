
import fs from 'node:fs'
import path from 'node:path'
import type { Database } from './database.js'
import type { TaskStore } from './task-store.js'
import type { ScheduledTaskStore } from './scheduled-task-store.js'
import { parseCronExpression, getNextRunTime } from './cron-parser.js'
import { getActiveProvider, getActiveModelId } from './provider-config.js'
import { getConfigDir, loadConfig } from './config.js'
import { SETTINGS_THINKING_LEVELS, type SettingsThinkingLevel } from './contracts/settings.js'
import { normalizeThinkingLevel } from './thinking-level.js'

export type SlashCommandSurface = 'web' | 'telegram'

export interface SlashCommandMetadata {
  name: string
  aliases?: string[]
  description: string
  usage?: string
  surfaces: SlashCommandSurface[]
}

export interface SlashCommandDefinition extends SlashCommandMetadata {
  handler?: (ctx: SlashCommandContext) => Promise<string | null> | string | null
}

export interface SlashCommandContext {
  userId: string | null
  surface: SlashCommandSurface
  args: string
  command: SlashCommandDefinition
  registry: SlashCommandRegistry
  db?: Database
  taskStore?: TaskStore
  scheduledTaskStore?: ScheduledTaskStore
  onThinkingLevelChanged?: (level: SettingsThinkingLevel) => void
}

export interface ParsedSlashCommand {
  raw: string
  name: string
  args: string
}

export function parseSlashCommand(input: string): ParsedSlashCommand | null {
  if (typeof input !== 'string') return null
  const raw = input
  if (!raw.startsWith('/')) return null
  if (raw.startsWith('//')) return null
  const body = raw.slice(1)
  if (body.length === 0) return null

  const wsIdx = body.search(/\s/)
  let head = wsIdx === -1 ? body : body.slice(0, wsIdx)
  const args = wsIdx === -1 ? '' : body.slice(wsIdx + 1).trim()

  const atIdx = head.indexOf('@')
  if (atIdx !== -1) head = head.slice(0, atIdx)

  if (!/^[a-zA-Z0-9_]+$/.test(head)) return null

  return { raw, name: head.toLowerCase(), args }
}

export type SlashCommandDispatchResult =
  | { kind: 'no_command' }
  | { kind: 'not_found'; name: string }
  | { kind: 'wrong_surface'; command: SlashCommandDefinition }
  | { kind: 'external'; command: SlashCommandDefinition; args: string }
  | { kind: 'handled'; command: SlashCommandDefinition; reply: string | null }
  | { kind: 'error'; command: SlashCommandDefinition; error: Error }

export class SlashCommandRegistry {
  private byName = new Map<string, SlashCommandDefinition>()
  private aliasToName = new Map<string, string>()

  register(def: SlashCommandDefinition): this {
    const name = def.name.toLowerCase()
    if (!/^[a-z0-9_]+$/.test(name)) {
      throw new Error(`Invalid slash-command name: "${def.name}"`)
    }
    if (this.byName.has(name)) {
      throw new Error(`Slash command already registered: "${name}"`)
    }
    if (this.aliasToName.has(name)) {
      throw new Error(`Slash command name conflicts with existing alias: "${name}"`)
    }
    if (!def.surfaces || def.surfaces.length === 0) {
      throw new Error(`Slash command "${name}" must declare at least one surface`)
    }
    this.byName.set(name, { ...def, name })
    for (const alias of def.aliases ?? []) {
      const a = alias.toLowerCase()
      if (!/^[a-z0-9_]+$/.test(a)) {
        throw new Error(`Invalid slash-command alias: "${alias}"`)
      }
      if (this.byName.has(a) || this.aliasToName.has(a)) {
        throw new Error(`Slash command alias collides: "${a}"`)
      }
      this.aliasToName.set(a, name)
    }
    return this
  }

    resolve(nameOrAlias: string): SlashCommandDefinition | undefined {
    const key = nameOrAlias.toLowerCase()
    const direct = this.byName.get(key)
    if (direct) return direct
    const aliased = this.aliasToName.get(key)
    return aliased ? this.byName.get(aliased) : undefined
  }

    list(surface: SlashCommandSurface): SlashCommandDefinition[] {
    return [...this.byName.values()]
      .filter((c) => c.surfaces.includes(surface))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  async dispatch(
    input: string,
    ctxBase: Omit<SlashCommandContext, 'args' | 'command'>,
  ): Promise<SlashCommandDispatchResult> {
    const parsed = parseSlashCommand(input)
    if (!parsed) return { kind: 'no_command' }
    const def = this.resolve(parsed.name)
    if (!def) return { kind: 'not_found', name: parsed.name }
    if (!def.surfaces.includes(ctxBase.surface)) {
      return { kind: 'wrong_surface', command: def }
    }
    if (!def.handler) {
      return { kind: 'external', command: def, args: parsed.args }
    }
    try {
      const reply = await def.handler({ ...ctxBase, command: def, args: parsed.args })
      return { kind: 'handled', command: def, reply: reply ?? null }
    } catch (err) {
      return { kind: 'handled', command: def, reply: `⚠️ ${(err as Error).message || 'Slash command failed.'}` }
    }
  }
}


export function renderHelp(registry: SlashCommandRegistry, surface: SlashCommandSurface): string {
  const cmds = registry.list(surface)
  if (cmds.length === 0) return 'No slash commands are available on this surface.'
  const lines: string[] = ['Available commands:']
  const namePad = Math.max(...cmds.map((c) => c.name.length + 1))
  for (const c of cmds) {
    const head = `/${c.name}`.padEnd(namePad + 1)
    lines.push(`${head} — ${c.description}`)
  }
  return lines.join('\n')
}

export function registerBuiltInSlashCommands(registry: SlashCommandRegistry): void {
  registry.register({
    name: 'help',
    description: 'List available slash commands.',
    surfaces: ['web', 'telegram'],
    handler: (ctx) => renderHelp(ctx.registry, ctx.surface),
  })

  registry.register({
    name: 'tasks',
    description: 'Show recent and currently running background tasks.',
    surfaces: ['web', 'telegram'],
    handler: (ctx) => {
      if (!ctx.taskStore) return 'Task store is not available on this surface.'
      const running = ctx.taskStore.list({ status: 'running', limit: 10 })
      const recent = ctx.taskStore.list({ limit: 5 })
      return formatTasksReply(running, recent)
    },
  })

  registry.register({
    name: 'cronjobs',
    aliases: ['cron'],
    description: 'Show configured cronjobs and their next run times.',
    surfaces: ['web', 'telegram'],
    handler: (ctx) => {
      if (!ctx.scheduledTaskStore) return 'Cronjob store is not available on this surface.'
      const jobs = ctx.scheduledTaskStore.list().map((j) => ({
        id: j.id,
      name: j.name,
        cronExpression: j.schedule,
        enabled: j.enabled,
        nextRunAt: computeNextRunAt(j.schedule),
        lastRunAt: j.lastRunAt,
      }))
      return formatCronjobsReply(jobs)
    },
  })

  registry.register({
    name: 'settings',
    aliases: ['model'],
    description: 'Show the active provider and model.',
    surfaces: ['web', 'telegram'],
    handler: () => formatSettingsReply(),
  })

  registry.register({
    name: 'thinking',
    description: 'Show or set the main chat thinking level.',
  usage: '/thinking <off|minimal|low|medium|high|xhigh>',
    surfaces: ['web', 'telegram'],
    handler: (ctx) => handleThinkingCommand(ctx),
  })
}

function handleThinkingCommand(ctx: SlashCommandContext): string {
  const args = ctx.args.trim().toLowerCase()
  if (!args) {
    const current = readConfiguredThinkingLevel() ?? 'off'
    return `Current thinking level: ${current}\nUsage: /thinking ${SETTINGS_THINKING_LEVELS.join('|')}`
  }

  const [level, ...rest] = args.split(/\s+/)
  if (rest.length > 0 || !level) {
    return `Usage: /thinking ${SETTINGS_THINKING_LEVELS.join('|')}`
  }

  const normalized = normalizeThinkingLevel(level)
  if (!normalized) {
    return `Unknown thinking level: ${level}\nValid levels: ${SETTINGS_THINKING_LEVELS.join(', ')}`
  }

  writeConfiguredThinkingLevel(normalized)
  ctx.onThinkingLevelChanged?.(normalized)
  return `Thinking level set to: ${normalized}`
}

function readConfiguredThinkingLevel(): SettingsThinkingLevel | undefined {
  try {
    const settings = loadConfig<{ thinkingLevel?: string }>('settings.json')
    return normalizeThinkingLevel(settings.thinkingLevel)
  } catch {
    return undefined
  }
}

function writeConfiguredThinkingLevel(level: SettingsThinkingLevel): void {
  const settingsPath = path.join(getConfigDir(), 'settings.json')
  const settings = loadConfig<Record<string, unknown>>('settings.json')
  settings.thinkingLevel = level
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf-8')
}


interface TaskLike {
  id: string
  name: string
  status: string
  triggerType: string
  createdAt: string
  finishedAt?: string | null
}

export function formatTasksReply(running: TaskLike[], recent: TaskLike[]): string {
  const lines: string[] = []
  lines.push(`Running tasks: ${running.length}`)
  if (running.length > 0) {
    for (const t of running.slice(0, 10)) {
      lines.push(`  • ${truncate(t.name, 60)} (${t.triggerType}) — started ${t.createdAt}`)
    }
  }
  lines.push('')
  lines.push('Recent tasks (newest first):')
  if (recent.length === 0) {
    lines.push('  (none)')
  } else {
    for (const t of recent.slice(0, 5)) {
      const when = t.finishedAt ?? t.createdAt
      lines.push(`  • [${t.status}] ${truncate(t.name, 60)} — ${when}`)
    }
  }
  return lines.join('\n')
}

interface CronjobLike {
  id: string
  name: string
  cronExpression: string
  enabled: boolean
  nextRunAt?: string | null
  lastRunAt?: string | null
}

export function formatCronjobsReply(jobs: CronjobLike[]): string {
  if (jobs.length === 0) return 'No cronjobs configured.'
  const lines: string[] = [`Configured cronjobs: ${jobs.length}`]
  for (const j of jobs) {
    const state = j.enabled ? 'on ' : 'off'
    const next = j.nextRunAt ?? '—'
    lines.push(`  • [${state}] ${truncate(j.name, 50)} — ${j.cronExpression} (next: ${next})`)
  }
  return lines.join('\n')
}

export function formatSettingsReply(): string {
  try {
    const provider = getActiveProvider()
    if (!provider) return 'No active provider is configured.'
    const modelId = getActiveModelId() ?? provider.defaultModel ?? '(none)'
    const lines = [
      `Active provider: ${provider.name} (${provider.providerType})`,
      `Active model: ${modelId}`,
    ]
    return lines.join('\n')
  } catch (err) {
    return `Could not read provider settings: ${(err as Error).message}`
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max - 1) + '…'
}

function computeNextRunAt(schedule: string): string | null {
  try {
    const fields = parseCronExpression(schedule)
    const next = getNextRunTime(fields, new Date())
    if (!next) return null
    return next.toISOString().replace('T', ' ').slice(0, 16)
  } catch {
    return null
  }
}
