import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import type { TaskStatus, TaskTriggerType } from './task-store.js'
import type { ProviderConfig } from './provider-config.js'
import { resolveProviderModelInput } from './provider-config.js'
import type { TaskRuntimeTaskBoundary } from './task-runtime.js'

export interface TaskToolsOptions {
  taskRuntime: TaskRuntimeTaskBoundary
  /** Get the default provider to use for tasks */
  getDefaultProvider: () => ProviderConfig
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
}

/**
 * Create the `resume_task` agent tool
 */
export function createResumeTaskTool(options: TaskToolsOptions): AgentTool {
  return {
    name: 'resume_task',
    label: 'Resume Paused Task',
    description:
      'Send a response to a paused background task. Use this when a task has asked a question ' +
      '(status: question) and the user has now answered. Include the answer plus any brief context the task needs, then the task resumes in the background.',
    parameters: Type.Object({
      task_id: Type.String({
        description: 'The ID of the paused task to resume.',
      }),
      message: Type.String({
        description: 'The response message to send to the paused task. Include the user\'s answer and any relevant context.',
      }),
    }),
    execute: async (_toolCallId, params) => {
      const { task_id, message } = params as { task_id: string; message: string }

      try {
        // Check task exists
        const task = options.taskRuntime.getById(task_id)
        if (!task) {
          return {
            content: [{ type: 'text' as const, text: `Error: Task "${task_id}" not found.` }],
            details: { error: true },
          }
        }

        if (task.status !== 'paused') {
          return {
            content: [{ type: 'text' as const, text: `Error: Task "${task_id}" is not paused (current status: ${task.status}).` }],
            details: { error: true },
          }
        }

        // Check if the task agent is still in memory
        if (!options.taskRuntime.isPaused(task_id)) {
          return {
            content: [{ type: 'text' as const, text: `Error: Task "${task_id}" agent is no longer in memory. The task may have timed out.` }],
            details: { error: true },
          }
        }

        // Resume the task
        const resumed = await options.taskRuntime.resume(task_id, message)
        if (!resumed) {
          return {
            content: [{ type: 'text' as const, text: `Error: Failed to resume task "${task_id}".` }],
            details: { error: true },
          }
        }

        return {
          content: [{
            type: 'text' as const,
            text: `Task "${task.name}" (${task_id}) has been resumed with your response. It will continue working in the background.`,
          }],
          details: {
            taskId: task_id,
            name: task.name,
            status: 'running',
          },
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: 'text' as const, text: `Error resuming task: ${errorMsg}` }],
          details: { error: true },
        }
      }
    },
  }
}

/**
 * Create the `create_task` agent tool
 */
export function createTaskTool(options: TaskToolsOptions): AgentTool {
  return {
    name: 'create_task',
    label: 'Create Background Task',
    description:
      'Start a background task that runs autonomously. Use this for complex, long-running, or parallelizable work ' +
      'that should continue in the background (e.g., building apps, substantial refactors, multi-step research, complex file operations). ' +
      'Do not use it for simple questions or quick checks you can finish in the current turn. ' +
      'Provide a self-contained prompt; the task runs in an isolated agent instance and reports back when complete, fails, or needs input.',
    parameters: Type.Object({
      prompt: Type.String({
        description: 'Detailed, self-contained prompt describing what the task should accomplish. Include the goal, constraints, relevant files or URLs, required checks, and the expected final deliverable. Write it so the task can proceed without relying on hidden chat context.',
      }),
      name: Type.String({
        description: 'Short, descriptive name for the task (e.g., "Build React App", "Research AI Papers")',
      }),
      provider: Type.Optional(
        Type.String({
          description: 'Provider name or id to use for this task (e.g. "Kimi.ai", "OpenAI"). Choose the most appropriate provider based on the descriptions in `<available_providers>`. You may autonomously select a model that matches the task\'s needs. Only pass this if you have a specific reason to deviate from the default task model. Can be combined with `model` to pin both.',
        })
      ),
      model: Type.Optional(
        Type.String({
          description: 'Specific model id to use for this task (e.g. "kimi-k2.6", "gpt-5", "claude-sonnet-4-5"). Choose based on the descriptions in `<available_providers>` — prefer cost-effective models for simple work and stronger models for complex coding or research. Only pass this if you have a specific reason to deviate from the default task model. If `provider` is omitted, the provider is auto-detected from the configured providers (requires a unique match).',
        })
      ),
      max_duration_minutes: Type.Optional(
        Type.Number({
          description: 'Maximum duration in minutes for this task. Cannot exceed the system maximum. Defaults to system default if not specified.',
        })
      ),
    }),
    execute: async (_toolCallId, params) => {
      const { prompt, name, provider: providerName, model: modelName, max_duration_minutes } = params as {
        prompt: string
        name: string
        provider?: string
        model?: string
        max_duration_minutes?: number
      }

      try {
        // Resolve (provider, model) into a concrete provider config.
        // - Both empty       → use default task provider
        // - Any combination  → run through the shared resolver so a bare
        //                       model name ("kimi-k2.6") auto-selects its
        //                       provider and an enabled-model guard runs.
        const isDefaultModel = !providerName && !modelName
        let provider: ProviderConfig
        if (providerName || modelName) {
          const resolved = resolveProviderModelInput({ provider: providerName, model: modelName })
          if (!resolved.ok) {
            return {
              content: [{ type: 'text' as const, text: `Error: ${resolved.error}` }],
              details: { error: true },
            }
          }
          const base = options.resolveProvider(resolved.providerId)
          if (!base) {
            return {
              content: [{ type: 'text' as const, text: `Error: Provider "${resolved.providerName}" could not be loaded.` }],
              details: { error: true },
            }
          }
          // Pin the requested model by cloning the provider config (same
          // pattern as `getTaskDefaultProvider` and the cron scheduler).
          provider = resolved.modelId === base.defaultModel
            ? base
            : { ...base, defaultModel: resolved.modelId }
        } else {
          provider = options.getDefaultProvider()
        }

        // Cap max duration
        let maxDuration = max_duration_minutes ?? options.defaultMaxDurationMinutes
        if (maxDuration > options.maxDurationMinutesCap) {
          maxDuration = options.maxDurationMinutesCap
        }
        if (maxDuration <= 0) {
          maxDuration = options.defaultMaxDurationMinutes
        }

        // Create the task in the store — sessionId is created by the
        // TaskRunner via SessionManager when the task starts.
        const task = options.taskRuntime.create({
          name,
          prompt,
          triggerType: 'agent',
          provider: provider.name,
          model: provider.defaultModel,
          isDefaultModel,
          maxDurationMinutes: maxDuration,
        })

        // Start the task, linking its session to the current interactive session
        const parentSessionId = options.getParentSessionId?.() ?? null
        await options.taskRuntime.start(task, provider, undefined, parentSessionId)

        return {
          content: [{
            type: 'text' as const,
            text: `Background task started successfully.\n\nTask ID: ${task.id}\nName: ${name}\nProvider: ${provider.name}\nMax Duration: ${maxDuration} minutes\n\nThe task is now running in the background. You will receive a notification when it completes or fails.`,
          }],
          details: {
            taskId: task.id,
            name,
            provider: provider.name,
            maxDurationMinutes: maxDuration,
          },
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: 'text' as const, text: `Error creating task: ${errorMsg}` }],
          details: { error: true },
        }
      }
    },
  }
}

/**
 * Create the `list_tasks` agent tool
 */
export function listTasksTool(options: Pick<TaskToolsOptions, 'taskRuntime'>): AgentTool {
  return {
    name: 'list_tasks',
    label: 'List Background Tasks',
    description:
      'List background tasks with optional filters. Use this to check the status of running tasks, ' +
      'find completed or failed tasks, or get an overview of all tasks. Returns the most recent tasks first.',
    parameters: Type.Object({
      status: Type.Optional(
        Type.String({
          description: 'Filter by status: "running", "paused", "completed", or "failed". Omit to show all.',
        })
      ),
      trigger_type: Type.Optional(
        Type.String({
          description: 'Filter by trigger type: "user", "agent", "cronjob", or "heartbeat". Omit to show all.',
        })
      ),
      limit: Type.Optional(
        Type.Number({
          description: 'Maximum number of tasks to return (default: 20, max: 50).',
        })
      ),
    }),
    execute: async (_toolCallId, params) => {
      const { status, trigger_type, limit } = params as {
        status?: string
        trigger_type?: string
        limit?: number
      }

      try {
        const tasks = options.taskRuntime.list({
          status: status as TaskStatus | undefined,
          triggerType: trigger_type as TaskTriggerType | undefined,
          limit: Math.min(limit ?? 20, 50),
        })

        if (tasks.length === 0) {
          const filterDesc = [status, trigger_type].filter(Boolean).join(', ')
          return {
            content: [{ type: 'text' as const, text: filterDesc
              ? `No tasks found matching filters: ${filterDesc}.`
              : 'No tasks found.'
            }],
            details: { count: 0 },
          }
        }

        const lines = tasks.map(t => {
          const duration = t.startedAt
            ? (() => {
                const start = new Date(t.startedAt.replace(' ', 'T') + 'Z').getTime()
                const end = t.completedAt
                  ? new Date(t.completedAt.replace(' ', 'T') + 'Z').getTime()
                  : Date.now()
                const mins = Math.round((end - start) / 60000)
                return mins < 1 ? '<1m' : `${mins}m`
              })()
            : '\u2014'
          const tokens = t.promptTokens + t.completionTokens
          return `\u2022 [${t.status.toUpperCase()}] ${t.name}\n  ID: ${t.id}\n  Trigger: ${t.triggerType} | Duration: ${duration} | Tokens: ${tokens} | Cost: $${t.estimatedCost.toFixed(4)}\n  Created: ${t.createdAt}`
        })

        return {
          content: [{ type: 'text' as const, text: `Found ${tasks.length} task(s):\n\n${lines.join('\n\n')}` }],
          details: { count: tasks.length },
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: 'text' as const, text: `Error listing tasks: ${errorMsg}` }],
          details: { error: true },
        }
      }
    },
  }
}
