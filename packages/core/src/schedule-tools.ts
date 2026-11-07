import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import { StringEnum } from '@earendil-works/pi-ai'
import { Type } from 'typebox'
import type { TSchema } from 'typebox'
import type { ScheduledTask, ScheduledTaskActionType, UpdateScheduledTaskInput } from './scheduled-task-store.js'
import type { TaskRuntimeScheduleBoundary } from './task-runtime.js'
import { formatDateKey, formatTimeKey } from './memory.js'
import { validateCronExpression, cronToHumanReadable, parseCronExpression, getNextRunTime } from './cron-parser.js'
import { resolveProviderModelInput } from './provider-config.js'
import { normalizeAttachedSkills } from './attached-skills.js'
import { parseThinkingLevelArg } from './thinking-level.js'
import { can, canCreateFor, getViewLevel } from './access-policy.js'
import type { AccessAction, AccessActor } from './access-policy.js'
import { AGENT_RUN_PARAMETERS, defineActionTool } from './action-tool.js'
import type { ActionTool } from './action-tool.js'
import type { ScheduleToolType } from './contracts/tool-names.js'

export interface ScheduleToolsOptions {
  taskRuntime: TaskRuntimeScheduleBoundary
  /** The user the tools act for; schedules are created for and limited to this user by the access policy. */
  actor?: AccessActor
  /** Username lookup for the owner shown in admin listings of foreign schedules. */
  getUsername?: (userId: number) => string | null
  /** Timezone a schedule of this owner runs in; UTC when not provided. */
  getTimezone?: (ownerUserId: number | null) => string
}

type ToolResult = AgentToolResult<unknown>

const SCHEDULE_TYPES = ['task', 'reminder'] as const satisfies readonly ScheduleToolType[]

function toolError(text: string, extra: Record<string, unknown> = {}): ToolResult {
  return { content: [{ type: 'text' as const, text }], details: { error: true, ...extra } }
}

function textResult(text: string, details: unknown): ToolResult {
  return { content: [{ type: 'text' as const, text }], details }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function scheduleResource(schedule: { ownerUserId: number | null }) {
  return { kind: 'cronjob' as const, ownerId: schedule.ownerUserId }
}

function toActionType(type: ScheduleToolType): ScheduledTaskActionType {
  return type === 'reminder' ? 'injection' : 'task'
}

function toScheduleType(actionType: ScheduledTaskActionType): ScheduleToolType {
  return actionType === 'injection' ? 'reminder' : 'task'
}

function typeLabel(actionType: ScheduledTaskActionType): string {
  return actionType === 'injection' ? 'reminder (static message)' : 'task (full agent run)'
}

/**
 * Resolves the (provider, model) pair into the composite `providerId:modelId`
 * stored in `scheduled_tasks.provider`; `undefined` means "task default at fire time".
 */
function resolveProviderValue(provider?: string, model?: string):
  | { ok: true; value: string | undefined; label: string | null }
  | { ok: false; error: string } {
  if (!provider && !model) return { ok: true, value: undefined, label: null }
  const resolved = resolveProviderModelInput({ provider, model })
  if (!resolved.ok) return resolved
  return { ok: true, value: resolved.composite, label: `${resolved.providerName} (${resolved.modelId})` }
}

/**
 * Null when the actor may perform the action. A schedule the actor may not see
 * is reported as missing so its existence stays private; an admin gets an
 * explicit reason for actions only the owner may do.
 */
function denyScheduleAction(
  options: ScheduleToolsOptions,
  schedule: { id: string; ownerUserId: number | null },
  action: AccessAction,
  verb: string,
): ToolResult | null {
  const { actor } = options
  if (!actor || can(actor, scheduleResource(schedule), action, 'agent')) return null
  if (actor.role === 'admin') {
    return toolError(`Error: Schedule "${schedule.id}" belongs to another user; you may only disable or remove it, not ${verb} it.`)
  }
  return toolError(`Error: Schedule "${schedule.id}" not found.`)
}

function timezoneFor(options: ScheduleToolsOptions, ownerUserId: number | null): string {
  return options.getTimezone?.(ownerUserId) ?? 'UTC'
}

function formatRunTime(date: Date, timezone: string): string {
  return `${formatDateKey(date, timezone)} ${formatTimeKey(date, timezone)} ${timezone}`
}

function nextRunTimes(schedule: string, timezone: string, count: number): string[] {
  try {
    const fields = parseCronExpression(schedule)
    const runs: string[] = []
    let cursor = new Date(Date.now() - 60000)
    for (let i = 0; i < count; i++) {
      const next = getNextRunTime(fields, cursor, timezone)
      if (!next) break
      runs.push(formatRunTime(next, timezone))
      cursor = next
    }
    return runs
  } catch {
    return []
  }
}

function ownerLabel(options: ScheduleToolsOptions, ownerUserId: number | null): string {
  if (ownerUserId === null) return 'unknown'
  return options.getUsername?.(ownerUserId) ?? `user ${ownerUserId}`
}

function formatForeignSummary(options: ScheduleToolsOptions, cj: ScheduledTask): string {
  const status = cj.enabled ? 'ENABLED' : 'DISABLED'
  return `[${status}] ${cj.name}\nID: ${cj.id}\nOwner: ${ownerLabel(options, cj.ownerUserId)} (details are private)`
}

function isMetadataOnly(options: ScheduleToolsOptions, cj: ScheduledTask): boolean {
  return !!options.actor && getViewLevel(options.actor, scheduleResource(cj), 'agent') === 'metadata'
}

function ownerFor(options: ScheduleToolsOptions): number | undefined {
  return options.actor && canCreateFor(options.actor, options.actor.id) ? options.actor.id : undefined
}

function looksLikeDynamicTaskRequest(name: string, message: string): boolean {
  const text = `${name}\n${message}`.toLowerCase()

  const dynamicPatterns = [
    /\b(current|latest|aktuell(?:e|en|er)?|neueste[nsmr]?)\b/u,
    /\b(weather|wetter|forecast|temperature|temperatur)\b/u,
    /\b(check|prüf(?:e|en)?|verify|look up|lookup|fetch|get|hole|ermittle)\b/u,
    /\b(search|research|analy[sz]e|analysiere|summari[sz]e|fasse .* zusammen)\b/u,
    /\b(use skill|verwende skill|nutze skill|mit skill)\b/u,
    /\b(report|berichte|teile .* mit|send me the result|schick .* ergebnis)\b/u,
    /\b(call|invoke|run)\b.{0,40}\b(tool|agent|skill)\b/u,
  ]

  return dynamicPatterns.some(pattern => pattern.test(text))
}

const DYNAMIC_REMINDER_ERROR =
  'Error: type "reminder" only supports static text delivered verbatim. This request looks dynamic (for example checking current data, using a skill/tool, or doing work at run time). Use schedule_write with type "task" instead.'

function cronError(schedule: string): ToolResult | null {
  const validationError = validateCronExpression(schedule)
  return validationError ? toolError(`Error: Invalid cron expression "${schedule}". ${validationError}`) : null
}

function parseScheduleType(value: unknown): ScheduleToolType | undefined | { error: string } {
  if (value === undefined || value === null || value === '') return undefined
  if (value === 'task' || value === 'reminder') return value
  return { error: `Error: Invalid type "${String(value)}". Valid types: ${SCHEDULE_TYPES.join(', ')}.` }
}

interface ScheduleWriteParams extends Record<string, unknown> {
  id?: string
  type?: string
  name?: string
  prompt?: string
  schedule?: string
  enabled?: boolean
  provider?: string
  model?: string
  thinking_level?: string
  attached_skills?: string[]
}

const AGENT_RUN_FIELDS = ['provider', 'model', 'thinking_level', 'attached_skills'] as const

async function createSchedule(options: ScheduleToolsOptions, params: ScheduleWriteParams): Promise<ToolResult> {
  const name = params.name!
  const prompt = params.prompt!
  const schedule = params.schedule!
  const type = parseScheduleType(params.type)
  if (typeof type === 'object') return toolError(type.error)
  return type === 'reminder'
    ? createReminder(options, { name, prompt, schedule }, params)
    : createTaskSchedule(options, { name, prompt, schedule }, params)
}

async function createReminder(
  options: ScheduleToolsOptions,
  { name, prompt, schedule }: { name: string; prompt: string; schedule: string },
  params: ScheduleWriteParams,
): Promise<ToolResult> {
  const unsupported = AGENT_RUN_FIELDS.filter(field => params[field] !== undefined)
  if (unsupported.length > 0) {
    return toolError(`Error: ${unsupported.join(', ')} ${unsupported.length === 1 ? 'is' : 'are'} not supported for type=reminder, because a reminder runs no agent. Use type "task" for agent runs.`)
  }
  if (looksLikeDynamicTaskRequest(name, prompt)) {
    return toolError(DYNAMIC_REMINDER_ERROR, { suggestedType: 'task' })
  }
  const invalidCron = cronError(schedule)
  if (invalidCron) return invalidCron

  const ownerUserId = ownerFor(options)
  const created = options.taskRuntime.create({
    name,
    prompt,
    schedule,
    actionType: 'injection',
    enabled: true,
    ownerUserId,
  })
  options.taskRuntime.register(created)

  const humanSchedule = cronToHumanReadable(schedule)
  const timezone = timezoneFor(options, ownerUserId ?? null)
  const [nextRun] = nextRunTimes(schedule, timezone, 1)
  const nextRunLine = nextRun ? `\nNext delivery: ${nextRun}` : ''

  return textResult(
    `Reminder created successfully.\n\nID: ${created.id}\nName: ${name}\nSchedule: ${humanSchedule} (${schedule})\nMessage: ${prompt}${nextRunLine}\n\nThe reminder will be delivered into the chat at the scheduled time.`,
    { cronjobId: created.id, name, schedule, humanSchedule, type: 'reminder', actionType: 'injection', message: prompt },
  )
}

async function createTaskSchedule(
  options: ScheduleToolsOptions,
  { name, prompt, schedule }: { name: string; prompt: string; schedule: string },
  params: ScheduleWriteParams,
): Promise<ToolResult> {
  const thinking = parseThinkingLevelArg(params.thinking_level)
  if (!thinking.ok) return toolError(`Error: ${thinking.error}`)
  const invalidCron = cronError(schedule)
  if (invalidCron) return invalidCron
  const provider = resolveProviderValue(params.provider, params.model)
  if (!provider.ok) return toolError(`Error: ${provider.error}`)

  const created = options.taskRuntime.create({
    name,
    prompt,
    schedule,
    actionType: 'task',
    provider: provider.value,
    enabled: true,
    ownerUserId: ownerFor(options),
    attachedSkills: normalizeAttachedSkills(params.attached_skills) ?? undefined,
    thinkingLevel: thinking.value ?? null,
  })
  options.taskRuntime.register(created)

  const humanSchedule = cronToHumanReadable(schedule)
  const lines = [
    'Cronjob created successfully.',
    '',
    `ID: ${created.id}`,
    `Name: ${name}`,
    `Schedule: ${humanSchedule} (${schedule})`,
    `Type: ${typeLabel('task')}`,
    ...(provider.label ? [`Provider: ${provider.label}`] : []),
    `Thinking: ${created.thinkingLevel ?? 'default'}`,
    ...(created.attachedSkills?.length ? [`Attached skills: ${created.attachedSkills.join(', ')}`] : []),
    'Status: Enabled',
    '',
    'The cronjob is now active and will run on the specified schedule.',
  ]

  return textResult(lines.join('\n'), {
    cronjobId: created.id,
    name,
    schedule,
    humanSchedule,
    type: 'task',
    actionType: 'task',
    provider: provider.value ?? null,
    providerLabel: provider.label,
    attachedSkills: created.attachedSkills ?? null,
    thinkingLevel: created.thinkingLevel,
  })
}

type EditPreparation = { ok: true; updates: UpdateScheduledTaskInput } | { ok: false; error: ToolResult }

function editFailure(error: ToolResult): EditPreparation {
  return { ok: false, error }
}

function resolveThinkingUpdate(value: string | undefined): { ok: true; value: UpdateScheduledTaskInput['thinkingLevel'] } | { ok: false; error: string } {
  if (value?.trim().toLowerCase() === 'default') return { ok: true, value: null }
  return parseThinkingLevelArg(value)
}

function resolveProviderUpdate(provider?: string, model?: string): { ok: true; value: string | undefined } | { ok: false; error: string } {
  if (provider === undefined && model === undefined) return { ok: true, value: undefined }
  return resolveProviderValue(provider, model)
}

function isDynamicReminderEdit(existing: ScheduledTask, params: ScheduleWriteParams, type: ScheduleToolType | undefined): boolean {
  const resultingType = type ?? toScheduleType(existing.actionType)
  if (resultingType !== 'reminder' || (type === undefined && params.prompt === undefined)) return false
  return looksLikeDynamicTaskRequest(params.name ?? existing.name, params.prompt ?? existing.prompt)
}

function prepareEdit(existing: ScheduledTask, params: ScheduleWriteParams, type: ScheduleToolType | undefined): EditPreparation {
  const thinking = resolveThinkingUpdate(params.thinking_level)
  if (!thinking.ok) return editFailure(toolError(`Error: ${thinking.error}`))
  const invalidCron = params.schedule ? cronError(params.schedule) : null
  if (invalidCron) return editFailure(invalidCron)
  if (isDynamicReminderEdit(existing, params, type)) return editFailure(toolError(DYNAMIC_REMINDER_ERROR, { suggestedType: 'task' }))
  const provider = resolveProviderUpdate(params.provider, params.model)
  if (!provider.ok) return editFailure(toolError(`Error: ${provider.error}`))

  return {
    ok: true,
    updates: {
      prompt: params.prompt,
      name: params.name,
      schedule: params.schedule,
      actionType: type ? toActionType(type) : undefined,
      provider: provider.value,
      enabled: params.enabled,
      attachedSkills: params.attached_skills === undefined ? undefined : normalizeAttachedSkills(params.attached_skills),
      thinkingLevel: thinking.value,
    },
  }
}

function isToggleOnly(params: ScheduleWriteParams): boolean {
  const { prompt, name, schedule, type, provider, model, attached_skills, thinking_level } = params
  return params.enabled !== undefined
    && [prompt, name, schedule, type, provider, model, attached_skills, thinking_level].every(value => value === undefined)
}

function formatEditResult(options: ScheduleToolsOptions, updated: ScheduledTask): ToolResult {
  if (isMetadataOnly(options, updated)) {
    return textResult(
      `Schedule updated successfully.\n\n${formatForeignSummary(options, updated)}`,
      { cronjobId: updated.id, name: updated.name, enabled: updated.enabled, ownerUserId: updated.ownerUserId },
    )
  }

  const humanSchedule = cronToHumanReadable(updated.schedule)
  const attachedSkillsText = updated.attachedSkills?.length ? updated.attachedSkills.join(', ') : 'none'
  const text = [
    'Schedule updated successfully.',
    '',
    `ID: ${updated.id}`,
    `Name: ${updated.name}`,
    `Schedule: ${humanSchedule} (${updated.schedule})`,
    `Type: ${typeLabel(updated.actionType)}`,
    `Provider: ${updated.provider ?? 'default'}`,
    `Thinking: ${updated.thinkingLevel ?? 'default'}`,
    `Attached skills: ${attachedSkillsText}`,
    `Status: ${updated.enabled ? 'Enabled' : 'Disabled'}`,
  ].join('\n')

  return textResult(text, {
    cronjobId: updated.id,
    name: updated.name,
    schedule: updated.schedule,
    humanSchedule,
    type: toScheduleType(updated.actionType),
    actionType: updated.actionType,
    provider: updated.provider,
    enabled: updated.enabled,
    attachedSkills: updated.attachedSkills ?? null,
    thinkingLevel: updated.thinkingLevel,
  })
}

async function editSchedule(options: ScheduleToolsOptions, params: ScheduleWriteParams): Promise<ToolResult> {
  const id = params.id!
  const type = parseScheduleType(params.type)
  if (typeof type === 'object') return toolError(type.error)

  const existing = options.taskRuntime.getById(id)
  if (!existing) return toolError(`Error: Schedule "${id}" not found.`)

  const denied = denyScheduleAction(options, existing, isToggleOnly(params) ? 'toggle' : 'edit', 'edit')
  if (denied) return denied

  const prepared = prepareEdit(existing, params, type)
  if (!prepared.ok) return prepared.error

  const updated = options.taskRuntime.update(id, prepared.updates)
  if (!updated) return toolError(`Error: Failed to update schedule "${id}".`)

  options.taskRuntime.register(updated)
  return formatEditResult(options, updated)
}

async function removeSchedule(options: ScheduleToolsOptions, params: ScheduleWriteParams): Promise<ToolResult> {
  const id = params.id!
  const existing = options.taskRuntime.getById(id)
  if (!existing) return toolError(`Error: Schedule "${id}" not found.`)

  const denied = denyScheduleAction(options, existing, 'delete', 'remove')
  if (denied) return denied

  options.taskRuntime.unregister(id)
  if (!options.taskRuntime.delete(id)) return toolError(`Error: Failed to remove schedule "${id}".`)

  return textResult(
    `Schedule "${existing.name}" (${id}) has been deleted.`,
    { cronjobId: id, name: existing.name, deleted: true },
  )
}

function withErrorHandling(verb: string, run: () => Promise<ToolResult>): Promise<ToolResult> {
  return run().catch(err => toolError(`Error ${verb}: ${errorMessage(err)}`))
}

export function createScheduleWriteTool(options: ScheduleToolsOptions): ActionTool {
  const parameters: Record<keyof ScheduleWriteParams & string, TSchema> = {
    id: Type.String({ description: 'ID of the schedule (from schedule_read).' }),
    type: StringEnum(SCHEDULE_TYPES, {
      description: '"task" (default) runs a full background agent on every fire. "reminder" delivers `prompt` verbatim into the chat: no agent, no tools, no fresh data. If unsure, choose "task".',
    }) as unknown as TSchema,
    name: Type.String({ description: 'Short, descriptive name (e.g. "Daily News Summary", "Pack bags reminder").' }),
    prompt: Type.String({
      description: 'For type "task": a self-contained prompt with goal, constraints and expected output for each run. For type "reminder": the exact static message delivered to the user.',
    }),
    schedule: Type.String({
      description: 'Cron expression with 5 fields (minute hour day-of-month month day-of-week), e.g. "0 9 * * *" for every day at 9:00.',
    }),
    enabled: Type.Boolean({ description: 'Enable or disable the schedule (edit only).' }),
    ...AGENT_RUN_PARAMETERS,
  }

  return defineActionTool<ScheduleWriteParams, 'create' | 'edit' | 'remove'>({
    name: 'schedule_write',
    label: 'Write Schedule',
    description:
      'Create, edit or remove scheduled actions: cronjobs (type "task") and reminders (type "reminder"). ' +
      'Use type "task" whenever the run must think, use tools or skills, fetch current data, check status, analyze something or produce a fresh result. ' +
      'Use type "reminder" only for a literal reminder or notification; it delivers static text and rejects dynamic requests. ' +
      'provider, model, thinking_level and attached_skills only apply to type "task". ' +
      'Convert natural-language times into a 5-field cron expression evaluated in the user\'s timezone: "every day at 9:00" → "0 9 * * *", "every 15 minutes" → "*/15 * * * *", "weekdays at 14:30" → "30 14 * * 1-5". ' +
      'For a one-time reminder use a fixed date, e.g. "30 11 30 3 *" for March 30 at 11:30. ' +
      'On edit only the passed fields change; read the current prompt with schedule_read action "get" before changing it.',
    parameters,
    actions: {
      create: {
        description: 'create a cronjob or reminder.',
        required: ['name', 'prompt', 'schedule'],
        replay: 'unsafe',
        execute: params => withErrorHandling('creating schedule', () => createSchedule(options, params)),
      },
      edit: {
        description: 'change only the passed fields of a schedule; pass only `enabled` to toggle it.',
        required: ['id'],
        replay: 'unsafe',
        execute: params => withErrorHandling('editing schedule', () => editSchedule(options, params)),
      },
      remove: {
        description: 'delete a schedule permanently.',
        required: ['id'],
        replay: 'unsafe',
        execute: params => withErrorHandling('removing schedule', () => removeSchedule(options, params)),
      },
    },
  })
}

interface ScheduleReadParams extends Record<string, unknown> {
  id?: string
  enabled_only?: boolean
  next_runs?: number
}

function formatListEntry(options: ScheduleToolsOptions, cj: ScheduledTask, numRuns: number): string {
  if (isMetadataOnly(options, cj)) return `\u2022 ${formatForeignSummary(options, cj).replace(/\n/g, '\n  ')}`

  const status = cj.enabled ? 'ENABLED' : 'DISABLED'
  const runs = cj.enabled ? nextRunTimes(cj.schedule, timezoneFor(options, cj.ownerUserId), numRuns) : []
  const lastRun = cj.lastRunAt ? `${cj.lastRunStatus ?? 'unknown'} at ${cj.lastRunAt}` : 'never'
  const lines = [
    `\u2022 [${status}] ${cj.name}`,
    `  ID: ${cj.id}`,
    `  Schedule: ${cronToHumanReadable(cj.schedule)} (${cj.schedule})`,
    `  Type: ${toScheduleType(cj.actionType)}`,
    ...(cj.actionType === 'task' ? [`  Provider: ${cj.provider ?? 'default'} | Thinking: ${cj.thinkingLevel ?? 'default'}`] : []),
    ...(cj.attachedSkills?.length ? [`  Attached skills: ${cj.attachedSkills.join(', ')}`] : []),
    `  Last run: ${lastRun}`,
    ...(runs.length > 0 ? [`  Next runs: ${runs.join(', ')}`] : []),
  ]
  return lines.join('\n')
}

async function listSchedules(options: ScheduleToolsOptions, params: ScheduleReadParams): Promise<ToolResult> {
  const { actor } = options
  const filters = actor && actor.role !== 'admin' ? { ownerUserId: actor.id } : undefined
  const schedules = (params.enabled_only ? options.taskRuntime.listEnabled(filters) : options.taskRuntime.list(filters))
    .filter(cj => !actor || can(actor, scheduleResource(cj), 'view', 'agent'))

  if (schedules.length === 0) {
    return textResult(params.enabled_only ? 'No enabled schedules found.' : 'No schedules configured.', { count: 0 })
  }

  const numRuns = Math.min(Math.max(params.next_runs ?? 3, 1), 10)
  const lines = schedules.map(cj => formatListEntry(options, cj, numRuns))
  return textResult(`Found ${schedules.length} schedule(s):\n\n${lines.join('\n\n')}`, { count: schedules.length })
}

async function getSchedule(options: ScheduleToolsOptions, params: ScheduleReadParams): Promise<ToolResult> {
  const id = params.id!
  const cj = options.taskRuntime.getById(id)
  const { actor } = options
  if (!cj || (actor && !can(actor, scheduleResource(cj), 'view', 'agent'))) {
    return toolError(`No schedule found with ID: ${id}`)
  }
  if (isMetadataOnly(options, cj)) {
    return textResult(formatForeignSummary(options, cj), {
      cronjob: { id: cj.id, name: cj.name, enabled: cj.enabled, ownerUserId: cj.ownerUserId },
    })
  }

  const lastRun = cj.lastRunAt ? `${cj.lastRunStatus ?? 'unknown'} at ${cj.lastRunAt}` : 'never'
  const text = [
    `[${cj.enabled ? 'ENABLED' : 'DISABLED'}] ${cj.name}`,
    `ID: ${cj.id}`,
    `Schedule: ${cronToHumanReadable(cj.schedule)} (${cj.schedule})`,
    `Type: ${toScheduleType(cj.actionType)}`,
    `Provider: ${cj.provider ?? 'default'}`,
    `Thinking: ${cj.thinkingLevel ?? 'default'}`,
    `Attached skills: ${cj.attachedSkills?.length ? cj.attachedSkills.join(', ') : 'none'}`,
    `Last run: ${lastRun}`,
    '',
    'Prompt:',
    cj.prompt,
  ].join('\n')
  return textResult(text, { cronjob: cj })
}

export function createScheduleReadTool(options: ScheduleToolsOptions): ActionTool {
  return defineActionTool<ScheduleReadParams, 'list' | 'get'>({
    name: 'schedule_read',
    label: 'Read Schedules',
    description:
      'Read your cronjobs and reminders. "list" shows schedules, status and upcoming run times (answers "which cronjobs are active?", "what runs tomorrow morning?"); ' +
      '"get" returns the full configuration of one schedule including its complete prompt. Use "get" before editing a prompt.',
    parameters: {
      id: Type.String({ description: 'ID of the schedule to read.' }),
      enabled_only: Type.Boolean({ description: 'Only list enabled schedules. Default: false.' }),
      next_runs: Type.Number({ description: 'Number of upcoming run times per schedule (default: 3, max: 10).' }),
    },
    actions: {
      list: {
        description: 'list schedules.',
        replay: 'safe',
        execute: params => withErrorHandling('listing schedules', () => listSchedules(options, params)),
      },
      get: {
        description: 'full configuration of one schedule.',
        required: ['id'],
        replay: 'safe',
        execute: params => withErrorHandling('retrieving schedule', () => getSchedule(options, params)),
      },
    },
  })
}
