import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { Database } from './database.js'
import { createBaseAgentTools } from './agent-runtime.js'
import type { BaseAgentToolsOptions } from './agent-runtime.js'
import {
  createCronjobTool,
  createReminderTool,
  editCronjobTool,
  getCronjobTool,
  listCronjobsTool,
  removeCronjobTool,
} from './cronjob-tools.js'
import type { CronjobToolsOptions } from './cronjob-tools.js'
import { createSendFileTool } from './send-file-tool.js'
import { createResumeTaskTool, createStopTaskTool, createTaskTool, listTasksTool } from './task-tools.js'
import type { TaskToolsOptions } from './task-tools.js'
import type { UserScope } from './user-scope.js'
import { resolveOwnerTimezone } from './user-settings.js'

export interface ScopedToolsDeps {
  db: Database
  builtinToolsConfig?: BaseAgentToolsOptions['builtinToolsConfig']
  sttEnabled?: boolean
  quotaService?: BaseAgentToolsOptions['quotaService']
  getSessionId?: BaseAgentToolsOptions['getSessionId']
  /** Shared task tool settings; the scope supplies owner and actor. */
  taskTools: Omit<TaskToolsOptions, 'actor' | 'getUsername' | 'getParentSessionId'>
  /** Cronjob and reminder tools; only the interactive chat gets them. */
  cronjobTools?: Omit<CronjobToolsOptions, 'actor' | 'getUsername' | 'getTimezone'>
  /** Interactive session of the calling turn; omitted for background task agents. */
  getInteractiveSessionId?: () => string | null
  /** Set when the caller adds the base tool set itself (the chat runtime does). */
  excludeBaseTools?: boolean
}

function lookupUsername(db: Database, userId: number): string | null {
  const row = db.prepare('SELECT username FROM users WHERE id = ?').get(userId) as { username: string } | undefined
  return row?.username ?? null
}

/**
 * Builds the tool set of one user. Every tool is bound to the scope when it is
 * created, so parallel turns and tasks of different users never share state.
 */
export function createScopedTools(scope: UserScope, deps: ScopedToolsDeps): AgentTool[] {
  const actor = { id: scope.id, role: scope.role }
  const getParentSessionId = deps.getInteractiveSessionId ?? (() => null)
  const taskOptions: TaskToolsOptions = {
    ...deps.taskTools,
    actor,
    getUsername: (userId) => lookupUsername(deps.db, userId),
    getParentSessionId,
  }

  const cronjobOptions: CronjobToolsOptions | null = deps.cronjobTools
    ? { ...deps.cronjobTools, actor, getUsername: taskOptions.getUsername, getTimezone: (ownerUserId) => resolveOwnerTimezone(deps.db, ownerUserId) }
    : null

  return [
    ...(deps.excludeBaseTools
      ? []
      : createBaseAgentTools({
          db: deps.db,
          builtinToolsConfig: deps.builtinToolsConfig,
          sttEnabled: deps.sttEnabled,
          user: scope,
          quotaService: deps.quotaService,
          getSessionId: deps.getSessionId,
        })),
    createTaskTool(taskOptions),
    createResumeTaskTool(taskOptions),
    listTasksTool(taskOptions),
    createStopTaskTool(taskOptions),
    ...(cronjobOptions
      ? [
          createCronjobTool(cronjobOptions),
          editCronjobTool(cronjobOptions),
          removeCronjobTool(cronjobOptions),
          listCronjobsTool(cronjobOptions),
          getCronjobTool(cronjobOptions),
          createReminderTool(cronjobOptions),
        ]
      : []),
    createSendFileTool({
      getCurrentToolUserId: () => scope.id,
      getWorkspaceDir: () => scope.paths.workspace,
      getCurrentInteractiveSessionId: deps.getInteractiveSessionId,
    }),
  ]
}
