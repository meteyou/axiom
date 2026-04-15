import type { Task } from '@openagent/core'
import type { TaskTimelineEvent } from './types.js'

export function mapTasksListResponse(input: {
  tasks: Task[]
  page: number
  limit: number
  total: number
}) {
  return {
    tasks: input.tasks,
    pagination: {
      page: input.page,
      limit: input.limit,
      total: input.total,
      totalPages: Math.ceil(input.total / input.limit),
    },
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
      prompt: input.task.prompt,
      resultSummary: input.task.resultSummary,
      errorMessage: input.task.errorMessage,
    },
  }
}
