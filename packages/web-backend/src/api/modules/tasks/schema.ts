import type { TaskStatus, TaskTriggerType } from '@openagent/core'

const VALID_STATUSES: TaskStatus[] = ['running', 'paused', 'completed', 'failed']
const VALID_TRIGGER_TYPES: TaskTriggerType[] = ['user', 'agent', 'cronjob', 'heartbeat', 'consolidation']

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

export interface RestartTaskInput {
  name?: string
  prompt?: string
  provider?: string
  model?: string
  maxDurationMinutes?: number
}

/**
 * Parse and validate the body of `POST /api/tasks/:id/restart`. All fields
 * are optional — unspecified fields inherit from the original task. An empty
 * string is treated as "use original value", so the client can send the form
 * as-is without having to diff against the original.
 */
export function parseRestartTaskBody(body: unknown): ParseResult<RestartTaskInput> {
  const b = (body ?? {}) as Record<string, unknown>
  const out: RestartTaskInput = {}

  if (b.name !== undefined && b.name !== null && b.name !== '') {
    if (typeof b.name !== 'string') return { ok: false, error: 'name must be a string' }
    const trimmed = b.name.trim()
    if (trimmed.length === 0) return { ok: false, error: 'name must not be empty' }
    if (trimmed.length > 200) return { ok: false, error: 'name must be at most 200 characters' }
    out.name = trimmed
  }

  if (b.prompt !== undefined && b.prompt !== null && b.prompt !== '') {
    if (typeof b.prompt !== 'string') return { ok: false, error: 'prompt must be a string' }
    const trimmed = b.prompt.trim()
    if (trimmed.length === 0) return { ok: false, error: 'prompt must not be empty' }
    out.prompt = trimmed
  }

  if (b.provider !== undefined && b.provider !== null && b.provider !== '') {
    if (typeof b.provider !== 'string') return { ok: false, error: 'provider must be a string' }
    out.provider = b.provider.trim()
  }

  if (b.model !== undefined && b.model !== null && b.model !== '') {
    if (typeof b.model !== 'string') return { ok: false, error: 'model must be a string' }
    out.model = b.model.trim()
  }

  if (b.maxDurationMinutes !== undefined && b.maxDurationMinutes !== null) {
    const n = typeof b.maxDurationMinutes === 'number'
      ? b.maxDurationMinutes
      : Number.parseInt(String(b.maxDurationMinutes), 10)
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
      return { ok: false, error: 'maxDurationMinutes must be a positive integer' }
    }
    out.maxDurationMinutes = n
  }

  return { ok: true, value: out }
}
