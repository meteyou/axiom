import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import { Type } from 'typebox'
import type { TSchema } from 'typebox'
import type { Task, TaskStatus, TaskTriggerType } from './task-store.js'
import type { ProviderConfig } from './provider-config.js'
import { resolveProviderModelInput, getProviderDefaultModel } from './provider-config.js'
import { normalizeAttachedSkills } from './attached-skills.js'
import type { TaskRuntimeTaskBoundary } from './task-runtime.js'
import { parseThinkingLevelArg } from './thinking-level.js'
import { can, canCreateFor, getViewLevel } from './access-policy.js'
import type { AccessActor } from './access-policy.js'
import { AGENT_RUN_PARAMETERS, defineActionTool } from './action-tool.js'
import type { ActionTool } from './action-tool.js'

export interface TaskToolsOptions {
  taskRuntime: TaskRuntimeTaskBoundary
  /** Get the default provider to use for tasks; null when none is configured */
  getDefaultProvider: () => ProviderConfig | null
  /** Resolve a provider by name/id */
  resolveProvider: (nameOrId: string) => ProviderConfig | null
  /** Default max duration from settings */
  defaultMaxDurationMinutes: number
  /** Hard cap on max duration from settings */
  maxDurationMinutesCap: number
  /**
   * Returns the current interactive session ID that triggered the tool call,
   * so that the new task's session can be linked via `parent_session_id`.
   * Returns null when no interactive session is active (e.g. tool invoked
   * from a background context).
   */
  getParentSessionId?: () => string | null
  /**
   * The user the tools act for. Tasks are created for this user and tools only
   * reach tasks the access policy allows. Without an actor (tests, legacy
   * callers) the tools stay unscoped.
   */
  actor?: AccessActor
  /** Username lookup for the owner shown in admin listings of foreign tasks. */
  getUsername?: (userId: number) => string | null
}

type ToolResult = AgentToolResult<unknown>

function toolError(text: string): ToolResult {
  return { content: [{ type: 'text' as const, text }], details: { error: true } }
}

function textResult(text: string, details: unknown): ToolResult {
  return { content: [{ type: 'text' as const, text }], details }
}

function withErrorHandling(verb: string, run: () => Promise<ToolResult>): Promise<ToolResult> {
  return run().catch(err => toolError(`Error ${verb}: ${err instanceof Error ? err.message : String(err)}`))
}

function taskResource(task: { ownerUserId: number | null }) {
  return { kind: 'task' as const, ownerId: task.ownerUserId }
}

/**
 * A task the actor may not see is reported as missing so its existence stays
 * private; an admin gets an explicit reason for actions only the owner may do.
 */
function foreignTaskError(actor: AccessActor, taskId: string, action: string): ToolResult {
  if (actor.role === 'admin') {
    return toolError(`Error: Task "${taskId}" belongs to another user; only its owner can ${action} it.`)
  }
  return toolError(`Error: Task "${taskId}" not found.`)
}

/** e.g. "Thinking: high", "Thinking: high (default)", "Thinking: medium → high (clamped to model)". */
export function formatThinkingLine(requested: string | null, effective: string | null): string {
  if (!effective) return `Thinking: ${requested ?? 'default'}`
  if (!requested) return `Thinking: ${effective} (default)`
  return requested === effective
    ? `Thinking: ${effective}`
    : `Thinking: ${requested} → ${effective} (clamped to model)`
}

interface TaskWriteParams extends Record<string, unknown> {
  task_id?: string
  name?: string
  prompt?: string
  message?: string
  max_duration_minutes?: number
  provider?: string
  model?: string
  thinking_level?: string
  attached_skills?: string[]
}

type ProviderResolution = { ok: true; provider: ProviderConfig; isDefaultModel: boolean } | { ok: false; error: ToolResult }

function resolveTaskProvider(options: TaskToolsOptions, providerName?: string, modelName?: string): ProviderResolution {
  if (!providerName && !modelName) {
    const provider = options.getDefaultProvider()
    if (!provider) {
      return { ok: false, error: toolError('Error: No default task provider is configured. Set one in Settings → Tasks, or pass an explicit provider/model.') }
    }
    return { ok: true, provider, isDefaultModel: true }
  }

  const resolved = resolveProviderModelInput({ provider: providerName, model: modelName })
  if (!resolved.ok) return { ok: false, error: toolError(`Error: ${resolved.error}`) }
  const base = options.resolveProvider(resolved.providerId)
  if (!base) return { ok: false, error: toolError(`Error: Provider "${resolved.providerName}" could not be loaded.`) }
  // Pin the requested model by cloning the provider config (same pattern as
  // `getTaskDefaultProvider` and the cron scheduler).
  const provider = resolved.modelId === getProviderDefaultModel(base)
    ? base
    : { ...base, enabledModels: [resolved.modelId] }
  return { ok: true, provider, isDefaultModel: false }
}

function resolveMaxDuration(options: TaskToolsOptions, requested?: number): number {
  const maxDuration = Math.min(requested ?? options.defaultMaxDurationMinutes, options.maxDurationMinutesCap)
  return maxDuration <= 0 ? options.defaultMaxDurationMinutes : maxDuration
}

async function createTask(options: TaskToolsOptions, params: TaskWriteParams): Promise<ToolResult> {
  const name = params.name!
  const prompt = params.prompt!
  const thinking = parseThinkingLevelArg(params.thinking_level)
  if (!thinking.ok) return toolError(`Error: ${thinking.error}`)

  const resolution = resolveTaskProvider(options, params.provider, params.model)
  if (!resolution.ok) return resolution.error
  const { provider, isDefaultModel } = resolution
  const model = getProviderDefaultModel(provider)
  const maxDuration = resolveMaxDuration(options, params.max_duration_minutes)

  // The TaskRunner creates the session via SessionManager when the task starts.
  const task = options.taskRuntime.create({
    name,
    prompt,
    triggerType: 'agent',
    ownerUserId: options.actor && canCreateFor(options.actor, options.actor.id) ? options.actor.id : undefined,
    provider: provider.name,
    model,
    isDefaultModel,
    thinkingLevel: thinking.value ?? null,
    maxDurationMinutes: maxDuration,
  })

  const parentSessionId = options.getParentSessionId?.() ?? null
  const attachedSkills = normalizeAttachedSkills(params.attached_skills)
  await options.taskRuntime.start(task, provider, { attachedSkills }, parentSessionId)

  const effectiveThinkingLevel = options.taskRuntime.getById(task.id)?.effectiveThinkingLevel ?? null
  const lines = [
    'Background task started successfully.',
    '',
    `Task ID: ${task.id}`,
    `Name: ${name}`,
    `Provider: ${provider.name}`,
    `Model: ${model}`,
    formatThinkingLine(thinking.value ?? null, effectiveThinkingLevel),
    `Max Duration: ${maxDuration} minutes`,
    ...(attachedSkills ? [`Attached skills: ${attachedSkills.join(', ')}`] : []),
    '',
    'The task is now running in the background. You will receive a notification when it completes or fails.',
  ]

  return textResult(lines.join('\n'), {
    taskId: task.id,
    name,
    provider: provider.name,
    model,
    thinkingLevel: thinking.value ?? null,
    effectiveThinkingLevel,
    maxDurationMinutes: maxDuration,
    attachedSkills,
  })
}

async function resumeTask(options: TaskToolsOptions, params: TaskWriteParams): Promise<ToolResult> {
  const taskId = params.task_id!
  const task = options.taskRuntime.getById(taskId)
  if (!task) return toolError(`Error: Task "${taskId}" not found.`)
  if (task.status !== 'paused') {
    return toolError(`Error: Task "${taskId}" is not paused (current status: ${task.status}).`)
  }
  if (options.actor && !can(options.actor, taskResource(task), 'resume', 'agent')) {
    return foreignTaskError(options.actor, taskId, 'resume')
  }
  if (!options.taskRuntime.isPaused(taskId)) {
    return toolError(`Error: Task "${taskId}" agent is no longer in memory. The task may have timed out.`)
  }
  if (!await options.taskRuntime.resume(taskId, params.message!)) {
    return toolError(`Error: Failed to resume task "${taskId}".`)
  }

  return textResult(
    `Task "${task.name}" (${taskId}) has been resumed with your response. It will continue working in the background.`,
    { taskId, name: task.name, status: 'running' },
  )
}

async function stopTask(options: TaskToolsOptions, params: TaskWriteParams): Promise<ToolResult> {
  const taskId = params.task_id!
  const task = options.taskRuntime.getById(taskId)
  if (!task || (options.actor && getViewLevel(options.actor, taskResource(task), 'agent') === 'none')) {
    return toolError(`Error: Task "${taskId}" not found.`)
  }
  if (options.actor && !can(options.actor, taskResource(task), 'stop', 'agent')) {
    return toolError(`Error: You are not allowed to stop task "${taskId}".`)
  }
  if (task.status !== 'running') {
    return toolError(`Error: Task "${taskId}" is not running (current status: ${task.status}).`)
  }

  options.taskRuntime.abort(task.id, 'Stopped by user via task_write')
  return textResult(`Task "${task.name}" (${task.id}) has been stopped.`, { taskId: task.id, name: task.name, status: 'failed' })
}

export function createTaskWriteTool(options: TaskToolsOptions): ActionTool {
  const parameters: Record<keyof TaskWriteParams & string, TSchema> = {
    task_id: Type.String({ description: 'ID of the task to resume or stop (from the task injection or task_read).' }),
    name: Type.String({ description: 'Short, descriptive task name (e.g. "Build React App", "Research AI Papers").' }),
    prompt: Type.String({
      description: 'Detailed, self-contained prompt with the goal, constraints, relevant files or URLs, required checks and the expected final deliverable. The task cannot see the chat history.',
    }),
    message: Type.String({
      description: 'Response for the paused task: the user\'s answer plus any context the task needs, since it has no chat history.',
    }),
    max_duration_minutes: Type.Number({
      description: 'Maximum run time in minutes. Defaults to the system default and cannot exceed the system maximum.',
    }),
    ...AGENT_RUN_PARAMETERS,
  }

  return defineActionTool<TaskWriteParams, 'create' | 'resume' | 'stop'>({
    name: 'task_write',
    label: 'Write Task',
    description:
      'Start, resume or stop background tasks. A task is an isolated agent run for complex, long-running or parallelizable work ' +
      '(building apps, substantial refactors, multi-step research, complex file operations) that reports back when it completes, fails or needs input. ' +
      'Do not create a task for simple questions or quick checks you can finish in the current turn. ' +
      'Use `attached_skills` to bake the rules of specific skills into the task prompt instead of hoping the task agent discovers them. ' +
      'Regular users can stop their own tasks; admins can stop any user\'s task.',
    parameters,
    actions: {
      create: {
        description: 'start a new background task.',
        required: ['name', 'prompt'],
        replay: 'unsafe',
        execute: params => withErrorHandling('creating task', () => createTask(options, params)),
      },
      resume: {
        description: 'answer a paused task (status: question) so it continues in the background.',
        required: ['task_id', 'message'],
        replay: 'unsafe',
        execute: params => withErrorHandling('resuming task', () => resumeTask(options, params)),
      },
      stop: {
        description: 'cancel a running task.',
        required: ['task_id'],
        replay: 'unsafe',
        execute: params => withErrorHandling('stopping task', () => stopTask(options, params)),
      },
    },
  })
}

function formatDuration(task: Task): string {
  if (!task.startedAt) return '\u2014'
  const start = new Date(task.startedAt.replace(' ', 'T') + 'Z').getTime()
  const end = task.completedAt ? new Date(task.completedAt.replace(' ', 'T') + 'Z').getTime() : Date.now()
  const mins = Math.round((end - start) / 60000)
  return mins < 1 ? '<1m' : `${mins}m`
}

function formatTaskEntry(options: Pick<TaskToolsOptions, 'actor' | 'getUsername'>, task: Task): string | null {
  const { actor } = options
  if (actor && !can(actor, taskResource(task), 'view', 'agent')) return null
  if (actor && getViewLevel(actor, taskResource(task), 'agent') === 'metadata') {
    const owner = task.ownerUserId != null ? options.getUsername?.(task.ownerUserId) ?? `user ${task.ownerUserId}` : 'unknown'
    return `\u2022 [${task.status.toUpperCase()}] ${task.name}\n  ID: ${task.id}\n  Owner: ${owner} (details are private)`
  }
  const tokens = task.promptTokens + task.completionTokens
  const modelLine = task.provider
    ? `\n  Model: ${task.provider}${task.model ? ` / ${task.model}` : ''} | ${formatThinkingLine(task.thinkingLevel, task.effectiveThinkingLevel)}`
    : ''
  return `\u2022 [${task.status.toUpperCase()}] ${task.name}\n  ID: ${task.id}\n  Trigger: ${task.triggerType} | Duration: ${formatDuration(task)} | Tokens: ${tokens} | Cost: $${task.estimatedCost.toFixed(4)}${modelLine}\n  Created: ${task.createdAt}`
}

/** `task_read`: lists background tasks the actor may see, most recent first. */
export function createTaskReadTool(options: Pick<TaskToolsOptions, 'taskRuntime' | 'actor' | 'getUsername'>): AgentTool {
  return {
    name: 'task_read',
    label: 'Read Tasks',
    description:
      'List background tasks with optional filters, most recent first. Use it to check the status of running tasks, ' +
      'find completed or failed tasks, look up a task id for task_write, or get an overview of all tasks.',
    parameters: Type.Object({
      status: Type.Optional(
        Type.String({ description: 'Filter by status: "running", "paused", "completed", or "failed". Omit to show all.' }),
      ),
      trigger_type: Type.Optional(
        Type.String({ description: 'Filter by trigger type: "user", "agent", "cronjob", or "heartbeat". Omit to show all.' }),
      ),
      limit: Type.Optional(
        Type.Number({ description: 'Maximum number of tasks to return (default: 20, max: 50).' }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const { status, trigger_type, limit } = params as { status?: string; trigger_type?: string; limit?: number }
      return withErrorHandling('listing tasks', async () => {
        const { actor } = options
        const tasks = options.taskRuntime.list({
          status: status as TaskStatus | undefined,
          triggerType: trigger_type as TaskTriggerType | undefined,
          limit: Math.min(limit ?? 20, 50),
          ownerUserId: actor && actor.role !== 'admin' ? actor.id : undefined,
        })

        const lines = tasks
          .map(task => formatTaskEntry(options, task))
          .filter((line): line is string => line !== null)

        if (lines.length === 0) {
          const filterDesc = [status, trigger_type].filter(Boolean).join(', ')
          return textResult(filterDesc ? `No tasks found matching filters: ${filterDesc}.` : 'No tasks found.', { count: 0 })
        }
        return textResult(`Found ${lines.length} task(s):\n\n${lines.join('\n\n')}`, { count: lines.length })
      })
    },
  }
}
