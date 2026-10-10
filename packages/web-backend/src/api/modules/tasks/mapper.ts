import type { Task } from '@axiom/core'
import type { TaskProviderFilterOption } from './service.js'
import type { TaskTimelineEvent } from './types.js'

export type OwnerNames = ReadonlyMap<number, string>

function withOwner(task: Task, owners: OwnerNames) {
  return { ...task, ownerUsername: task.ownerUserId != null ? owners.get(task.ownerUserId) ?? null : null }
}

export function mapTasksListResponse(input: {
  owners: OwnerNames
  tasks: Task[]
  page: number
  limit: number
  total: number
  providerOptions?: TaskProviderFilterOption[]
}) {
  return {
    tasks: input.tasks.map(task => withOwner(task, input.owners)),
    pagination: {
      page: input.page,
      limit: input.limit,
      total: input.total,
      totalPages: Math.ceil(input.total / input.limit),
    },
    providerOptions: input.providerOptions ?? [],
  }
}

export function mapTaskResponse(task: Task, owners: OwnerNames) {
  return { task: withOwner(task, owners) }
}

export function mapTaskEventsResponse(input: { task: Task; events: TaskTimelineEvent[]; owners: OwnerNames }) {
  return {
    events: input.events,
    task: {
      id: input.task.id,
      ownerUserId: input.task.ownerUserId,
      ownerUsername: withOwner(input.task, input.owners).ownerUsername,
      name: input.task.name,
      status: input.task.status,
      triggerType: input.task.triggerType,
      prompt: input.task.prompt,
      provider: input.task.provider,
      model: input.task.model,
      isDefaultModel: input.task.isDefaultModel,
      thinkingLevel: input.task.thinkingLevel,
      effectiveThinkingLevel: input.task.effectiveThinkingLevel,
      maxDurationMinutes: input.task.maxDurationMinutes,
      resultSummary: input.task.resultSummary,
      errorMessage: input.task.errorMessage,
    },
  }
}
