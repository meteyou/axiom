import type { AgentTool } from '@mariozechner/pi-agent-core'
import { Type } from '@mariozechner/pi-ai'
import type { TaskStore } from './task-store.js'
import type { TaskRunner } from './task-runner.js'
import type { ProviderConfig } from './provider-config.js'

export interface TaskToolsOptions {
  taskStore: TaskStore
  taskRunner: TaskRunner
  /** Get the default provider to use for tasks */
  getDefaultProvider: () => ProviderConfig
  /** Resolve a provider by name/id */
  resolveProvider: (nameOrId: string) => ProviderConfig | null
  /** Default max duration from settings */
  defaultMaxDurationMinutes: number
  /** Hard cap on max duration from settings */
  maxDurationMinutesCap: number
}

/**
 * Create the `create_task` agent tool
 */
export function createTaskTool(options: TaskToolsOptions): AgentTool {
  return {
    name: 'create_task',
    label: 'Create Background Task',
    description:
      'Start a background task that runs autonomously. Use this for complex, long-running work ' +
      'that the user wants done in the background (e.g., building apps, research, complex file operations). ' +
      'The task runs in an isolated agent instance and results are reported back when complete.',
    parameters: Type.Object({
      prompt: Type.String({
        description: 'Detailed prompt describing what the task should accomplish. Be specific and include all context needed.',
      }),
      name: Type.String({
        description: 'Short, descriptive name for the task (e.g., "Build React App", "Research AI Papers")',
      }),
      provider: Type.Optional(
        Type.String({
          description: 'Provider to use for this task. Only specify if the user explicitly requests a specific provider. Otherwise the default task provider is used.',
        })
      ),
      max_duration_minutes: Type.Optional(
        Type.Number({
          description: 'Maximum duration in minutes for this task. Cannot exceed the system maximum. Defaults to system default if not specified.',
        })
      ),
    }),
    execute: async (_toolCallId, params) => {
      const { prompt, name, provider: providerName, max_duration_minutes } = params as {
        prompt: string
        name: string
        provider?: string
        max_duration_minutes?: number
      }

      try {
        // Resolve provider
        let provider: ProviderConfig
        if (providerName) {
          const resolved = options.resolveProvider(providerName)
          if (!resolved) {
            return {
              content: [{ type: 'text' as const, text: `Error: Provider "${providerName}" not found. Using default provider.` }],
              details: { error: true },
            }
          }
          provider = resolved
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

        // Create the task in the store
        const task = options.taskStore.create({
          name,
          prompt,
          triggerType: 'agent',
          provider: provider.name,
          model: provider.defaultModel,
          maxDurationMinutes: maxDuration,
          sessionId: `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        })

        // Start the task
        await options.taskRunner.startTask(task, provider)

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
