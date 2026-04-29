import type { Task } from '@axiom/core'
import type { TaskProviderFilterOption } from './service.js'
import type { TaskTimelineEvent } from './types.js'

export function mapTasksListResponse(input: {
  tasks: Task[]
  page: number
  limit: number
  total: number
  providerOptions?: TaskProviderFilterOption[]
}) {
  return {
    tasks: input.tasks,
    pagination: {
      page: input.page,
      limit: input.limit,
      total: input.total,
      totalPages: Math.ceil(input.total / input.limit),
    },
    providerOptions: input.providerOptions ?? [],
  }
}

export function mapTaskResponse(task: Task) {
  return { task }
}

export function mapTaskEventsResponse(input: { task: Task; events: TaskTimelineEvent[] }) {
  return {
    events: input.events,
    task: {
      id: input.task.id,
      name: input.task.name,
      status: input.task.status,
      triggerType: input.task.triggerType,
      prompt: input.task.prompt,
      provider: input.task.provider,
      model: input.task.model,
      isDefaultModel: input.task.isDefaultModel,
      maxDurationMinutes: input.task.maxDurationMinutes,
      resultSummary: input.task.resultSummary,
      errorMessage: input.task.errorMessage,
    },
  }
}
