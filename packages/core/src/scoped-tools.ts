import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { AccessActor } from './access-policy.js'
import type { Database } from './database.js'
import { createBaseAgentTools } from './agent-runtime.js'
import type { BaseAgentToolsOptions } from './agent-runtime.js'
import { createScheduleReadTool, createScheduleWriteTool } from './schedule-tools.js'
import type { ScheduleToolsOptions } from './schedule-tools.js'
import { createSendFileTool } from './send-file-tool.js'
import { createTaskReadTool, createTaskWriteTool } from './task-tools.js'
import type { TaskToolsOptions } from './task-tools.js'
import type { UserScope } from './user-scope.js'
import { resolveOwnerTimezone } from './user-settings.js'

export interface ScopedToolsDeps {
  db: Database
  builtinToolsConfig?: BaseAgentToolsOptions['builtinToolsConfig']
  quotaService?: BaseAgentToolsOptions['quotaService']
  getSessionId?: BaseAgentToolsOptions['getSessionId']
  /** Shared task tool settings; the scope supplies owner and actor. */
  taskTools: Omit<TaskToolsOptions, 'actor' | 'getUsername' | 'getParentSessionId'>
  /** Cronjob and reminder tools; only the interactive chat gets them. */
  scheduleTools?: Omit<ScheduleToolsOptions, 'actor' | 'getUsername' | 'getTimezone'>
  /**
   * Interactive session of the calling turn; omitted for background task agents,
   * which then get no `file_send` (nothing would deliver the file).
   */
  getInteractiveSessionId?: () => string | null
  /** Set when the caller adds the base tool set itself (the chat runtime does). */
  excludeBaseTools?: boolean
}

function lookupUsername(db: Database, userId: number): string | null {
  const row = db.prepare('SELECT username FROM users WHERE id = ?').get(userId) as { username: string } | undefined
  return row?.username ?? null
}

function lookupRole(db: Database, userId: number): string {
  const row = db.prepare('SELECT role FROM users WHERE id = ? AND deleted_at IS NULL').get(userId) as { role: string } | undefined
  return row?.role ?? 'user'
}

/**
 * Builds the tool set of one user. Every tool is bound to the scope when it is
 * created, so parallel turns and tasks of different users never share state.
 */
export function createScopedTools(scope: UserScope, deps: ScopedToolsDeps): AgentTool[] {
  const actor: AccessActor = {
    id: scope.id,
    // Read on every check: a user's runtime outlives role changes.
    get role() { return lookupRole(deps.db, scope.id) },
  }
  const getParentSessionId = deps.getInteractiveSessionId ?? (() => null)
  const taskOptions: TaskToolsOptions = {
    ...deps.taskTools,
    actor,
    getUsername: (userId) => lookupUsername(deps.db, userId),
    getParentSessionId,
  }

  const scheduleOptions: ScheduleToolsOptions | null = deps.scheduleTools
    ? { ...deps.scheduleTools, actor, getUsername: taskOptions.getUsername, getTimezone: (ownerUserId) => resolveOwnerTimezone(deps.db, ownerUserId) }
    : null

  return [
    ...(deps.excludeBaseTools
      ? []
      : createBaseAgentTools({
          db: deps.db,
          builtinToolsConfig: deps.builtinToolsConfig,
          user: scope,
          quotaService: deps.quotaService,
          getSessionId: deps.getSessionId,
        })),
    createTaskReadTool(taskOptions),
    createTaskWriteTool(taskOptions),
    ...(scheduleOptions
      ? [createScheduleReadTool(scheduleOptions), createScheduleWriteTool(scheduleOptions)]
      : []),
    ...(deps.getInteractiveSessionId
      ? [createSendFileTool({
          getCurrentToolUserId: () => scope.id,
          getWorkspaceDir: () => scope.paths.workspace,
          getCurrentInteractiveSessionId: deps.getInteractiveSessionId,
        })]
      : []),
  ]
}
