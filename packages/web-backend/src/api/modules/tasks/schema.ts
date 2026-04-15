import type { TaskStatus, TaskTriggerType } from '@openagent/core'

const VALID_STATUSES: TaskStatus[] = ['running', 'paused', 'completed', 'failed']
const VALID_TRIGGER_TYPES: TaskTriggerType[] = ['user', 'agent', 'cronjob', 'heartbeat']

export interface ListTasksQuery {
  page: number
  limit: number
  offset: number
  status?: TaskStatus
  triggerType?: TaskTriggerType
}

interface ParseSuccess<T> {
  ok: true
  value: T
}

interface ParseFailure {
  ok: false
  error: string
}

type ParseResult<T> = ParseSuccess<T> | ParseFailure

function toOptionalString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value
  }
  if (Array.isArray(value) && typeof value[0] === 'string') {
    return value[0]
  }
  return undefined
}

export function parseListTasksQuery(query: Record<string, unknown>): ParseResult<ListTasksQuery> {
  const page = Math.max(1, Number.parseInt(toOptionalString(query.page) ?? '', 10) || 1)
  const limit = Math.min(100, Math.max(1, Number.parseInt(toOptionalString(query.limit) ?? '', 10) || 20))
  const offset = (page - 1) * limit

  const statusParam = toOptionalString(query.status)
  const triggerTypeParam = toOptionalString(query.trigger_type)

  if (statusParam && !VALID_STATUSES.includes(statusParam as TaskStatus)) {
    return {
      ok: false,
      error: `Invalid status filter. Must be one of: ${VALID_STATUSES.join(', ')}`,
    }
  }

  if (triggerTypeParam && !VALID_TRIGGER_TYPES.includes(triggerTypeParam as TaskTriggerType)) {
    return {
      ok: false,
      error: `Invalid trigger_type filter. Must be one of: ${VALID_TRIGGER_TYPES.join(', ')}`,
    }
  }

  return {
    ok: true,
    value: {
      page,
      limit,
      offset,
      status: statusParam as TaskStatus | undefined,
      triggerType: triggerTypeParam as TaskTriggerType | undefined,
    },
  }
}

export function parseTaskIdParam(id: unknown): string {
  return String(id)
}
