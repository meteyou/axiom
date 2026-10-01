import type { Task } from '~/api/tasks'

export type TaskStatusVariant = 'default' | 'success' | 'destructive' | 'warning' | 'muted'

export function taskStatusVariant(status: string): TaskStatusVariant {
  switch (status) {
    case 'running': return 'default'
    case 'completed': return 'success'
    case 'failed': return 'destructive'
    case 'paused': return 'warning'
    default: return 'muted'
  }
}

function parseSqliteTimestamp(value: string): number {
  return new Date(value.replace(' ', 'T') + 'Z').getTime()
}

export function formatTaskDuration(task: Pick<Task, 'startedAt' | 'completedAt'>): string {
  const start = task.startedAt ? parseSqliteTimestamp(task.startedAt) : null
  if (!start) return '—'

  const end = task.completedAt ? parseSqliteTimestamp(task.completedAt) : Date.now()

  const diffMs = end - start
  if (diffMs < 0) return '—'

  const seconds = Math.floor(diffMs / 1000)
  if (seconds < 60) return `${seconds}s`

  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`

  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return `${hours}h ${remainingMinutes}m`
}

export function hasCacheTokens(task: Pick<Task, 'cacheRead' | 'cacheWrite'>): boolean {
  return task.cacheRead > 0 || task.cacheWrite > 0
}

export function cacheHitRate(task: Pick<Task, 'promptTokens' | 'cacheRead' | 'cacheWrite'>): number | null {
  const denominator = task.promptTokens + task.cacheRead + task.cacheWrite
  if (denominator <= 0) return null
  return (task.cacheRead / denominator) * 100
}

export function cacheSummary(task: Pick<Task, 'promptTokens' | 'cacheRead' | 'cacheWrite'>): string {
  const rate = cacheHitRate(task)
  if (rate === null) return ''
  return `CH ${rate.toFixed(1)}%`
}

/**
 * Short thinking-level label for a task, or null when unknown (legacy rows).
 * Marks default levels and levels that were clamped to what the model supports.
 */
export function formatTaskThinking(
  task: Pick<Task, 'thinkingLevel' | 'effectiveThinkingLevel'>,
  t: (key: string, values?: Record<string, string>) => string,
): string | null {
  const effective = task.effectiveThinkingLevel ?? task.thinkingLevel
  if (!effective) return null
  const level = t(`tasks.thinkingLevels.${effective}`)
  if (!task.thinkingLevel) return t('tasks.thinkingDefault', { level })
  if (task.effectiveThinkingLevel && task.thinkingLevel !== task.effectiveThinkingLevel) {
    return t('tasks.thinkingClamped', { requested: t(`tasks.thinkingLevels.${task.thinkingLevel}`), level })
  }
  return t('tasks.thinking', { level })
}

export function formatTaskTriggerModel(
  task: Pick<Task, 'provider' | 'model' | 'isDefaultModel'>,
  t: (key: string, values: Record<string, string>) => string,
): string | null {
  if (!task.provider && !task.model) return null

  const parts = [task.provider, task.model].filter(Boolean).join(' – ')
  if (task.isDefaultModel === true) {
    return t('tasks.triggerModelDefault', { value: parts })
  }
  return parts
}
