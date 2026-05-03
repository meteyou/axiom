/**
 * Shared slash-command parser, registry and dispatcher.
 *
 * The same registry is used by the web chat WebSocket layer and the Telegram
 * bot so both surfaces understand the same vocabulary. A command is metadata
 * (`name`, `aliases`, `description`, `usage`, `surfaces`) plus an optional
 * `handler`. Surface-specific commands that need to mutate transport state
 * (e.g. aborting an in-flight WebSocket stream for `/stop`) register
 * themselves *without* a handler so the surface keeps its custom behaviour
 * while still appearing in `/help` and the Telegram command menu.
 *
 * Inspired by Hermes Agent's central `COMMAND_REGISTRY` (one source of truth
 * for CLI + messaging surfaces) and OpenClaw's `setMyCommands`-based Telegram
 * menu. Kept intentionally small for a first version: no skill commands,
 * autocomplete or destructive operations.
 */

import type { Database } from './database.js'
import type { TaskStore } from './task-store.js'
import type { ScheduledTaskStore } from './scheduled-task-store.js'
import { parseCronExpression, getNextRunTime } from './cron-parser.js'
import { getActiveProvider, getActiveModelId } from './provider-config.js'

/** Surface a command can be invoked from. */
export type SlashCommandSurface = 'web' | 'telegram'

/** Metadata describing a slash command. */
export interface SlashCommandMetadata {
  /** Canonical name without the leading slash. Lowercase, no whitespace. */
  name: string
  /** Optional alternate names (without leading slash). Lowercase. */
  aliases?: string[]
  /** One-line description shown in `/help` and the Telegram menu. */
  description: string
  /** Optional usage hint shown in detailed help (e.g. `/title <text>`). */
  usage?: string
  /** Surfaces this command is exposed on. */
  surfaces: SlashCommandSurface[]
}

/** Definition stored in the registry. Handler is optional for surface-owned commands. */
export interface SlashCommandDefinition extends SlashCommandMetadata {
  /**
   * Returns the markdown text reply, or `null` if the command produced no
   * reply (e.g. surface-owned commands that handle the response themselves).
   * Throwing inside a handler is caught by the dispatcher and surfaced as an
   * error reply — handlers should not need their own try/catch.
   */
  handler?: (ctx: SlashCommandContext) => Promise<string | null> | string | null
}

/** Per-invocation context passed to handlers. */
export interface SlashCommandContext {
  /** Axiom user ID as string, or `null` for unauthenticated/anonymous calls. */
  userId: string | null
  /** Surface that received the command. */
  surface: SlashCommandSurface
  /** Trimmed argument string after the command name (may be empty). */
  args: string
  /** The matched definition. */
  command: SlashCommandDefinition
  /** Registry — handlers may call `registry.list(surface)` for `/help`. */
  registry: SlashCommandRegistry
  /** Database, when the surface has one. */
  db?: Database
  /** Task store, when configured. */
  taskStore?: TaskStore
  /** Scheduled-task (cronjob) store, when configured. */
  scheduledTaskStore?: ScheduledTaskStore
}

/** Result of parsing an input string. */
export interface ParsedSlashCommand {
  /** The full raw line (input as given). */
  raw: string
  /** Lowercased name (without leading slash). */
  name: string
  /** Trimmed argument substring (may be empty). */
  args: string
}

/**
 * Parse a chat input. Returns `null` if the text is not a slash command (i.e.
 * does not start with `/`, contains whitespace before the slash, is just `/`,
 * or starts with `//` which is conventionally an escaped/literal slash).
 *
 * Rules:
 *  - Must start with exactly one `/`.
 *  - The command name is `[a-zA-Z0-9_]+` and is case-insensitive.
 *  - Telegram-style `@botname` suffix on the name is stripped.
 *  - Everything after the first whitespace is the argument string (trimmed).
 */
export function parseSlashCommand(input: string): ParsedSlashCommand | null {
  if (typeof input !== 'string') return null
  const raw = input
  // Do not trim leading whitespace: a message that starts with whitespace is
  // not a slash command.
  if (!raw.startsWith('/')) return null
  // Escaped slash: `//foo` is treated as literal text, not a command.
  if (raw.startsWith('//')) return null
  const body = raw.slice(1)
  if (body.length === 0) return null

  // Split off args at the first whitespace.
  const wsIdx = body.search(/\s/)
  let head = wsIdx === -1 ? body : body.slice(0, wsIdx)
  const args = wsIdx === -1 ? '' : body.slice(wsIdx + 1).trim()

  // Strip Telegram @botname suffix (e.g. `/help@my_bot`).
  const atIdx = head.indexOf('@')
  if (atIdx !== -1) head = head.slice(0, atIdx)

  if (!/^[a-zA-Z0-9_]+$/.test(head)) return null

  return { raw, name: head.toLowerCase(), args }
}

/** Outcome of `dispatch()`. */
export type SlashCommandDispatchResult =
  | { kind: 'no_command' }
  | { kind: 'not_found'; name: string }
  | { kind: 'wrong_surface'; command: SlashCommandDefinition }
  | { kind: 'external'; command: SlashCommandDefinition; args: string }
  | { kind: 'handled'; command: SlashCommandDefinition; reply: string | null }
  | { kind: 'error'; command: SlashCommandDefinition; error: Error }

/** Central registry of slash commands, shared by all surfaces. */
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

  /** Resolve a command by name or alias (case-insensitive). */
  resolve(nameOrAlias: string): SlashCommandDefinition | undefined {
    const key = nameOrAlias.toLowerCase()
    const direct = this.byName.get(key)
    if (direct) return direct
    const aliased = this.aliasToName.get(key)
    return aliased ? this.byName.get(aliased) : undefined
  }

  /** List commands available on the given surface, sorted by name. */
  list(surface: SlashCommandSurface): SlashCommandDefinition[] {
    return [...this.byName.values()]
      .filter((c) => c.surfaces.includes(surface))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  /**
   * Try to dispatch a chat input. Returns a discriminated result describing
   * what happened. Surfaces use the result to decide how to respond.
   */
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

// ---------------------------------------------------------------------------
// Built-in commands
// ---------------------------------------------------------------------------

/** Internal helper: render the help reply for a given surface. */
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

/**
 * Register the built-in read-only commands (`/help`, `/tasks`, `/cronjobs`,
 * `/settings`). Surfaces compose this with their own surface-specific
 * metadata-only entries (e.g. `/new`, `/stop`) to get a single source of
 * truth for `/help` and the Telegram menu.
 */
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
}

// ---------------------------------------------------------------------------
// Reply formatters (pure functions, exported for tests)
// ---------------------------------------------------------------------------

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
