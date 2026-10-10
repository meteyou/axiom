import type { UserRole } from './user-scope.js'

export interface AccessActor {
  id: number
  role: UserRole | string
}

export type AccessResourceKind = 'task' | 'cronjob'

export interface AccessResource {
  kind: AccessResourceKind
  ownerId: number | null
}

/** `ui` is the web UI / REST API; `agent` is everything an LLM tool or slash command does on a user's behalf. */
export type AccessChannel = 'ui' | 'agent'

export type AccessAction =
  | 'view'
  | 'stop'
  | 'delete'
  | 'toggle'
  | 'edit'
  | 'restart'
  | 'trigger'
  | 'resume'

export type ViewLevel = 'full' | 'metadata' | 'none'

const ACTIONS_BY_KIND: Record<AccessResourceKind, readonly AccessAction[]> = {
  task: ['view', 'stop', 'delete', 'restart', 'resume'],
  cronjob: ['view', 'delete', 'toggle', 'edit', 'trigger'],
}

const ADMIN_FOREIGN_ACTIONS: ReadonlySet<AccessAction> = new Set(['stop', 'delete', 'toggle'])

function isOwner(actor: AccessActor, resource: AccessResource): boolean {
  return resource.ownerId !== null && actor.id === resource.ownerId
}

function isAdmin(actor: AccessActor): boolean {
  return actor.role === 'admin'
}

/**
 * How much of a resource the actor may read. An admin sees foreign resources
 * completely in the UI, but through the agent only as title, owner and status.
 */
export function getViewLevel(actor: AccessActor, resource: AccessResource, channel: AccessChannel): ViewLevel {
  if (isOwner(actor, resource)) return 'full'
  if (!isAdmin(actor)) return 'none'
  return channel === 'ui' ? 'full' : 'metadata'
}

export function can(
  actor: AccessActor,
  resource: AccessResource,
  action: AccessAction,
  channel: AccessChannel,
): boolean {
  if (!ACTIONS_BY_KIND[resource.kind].includes(action)) return false
  if (action === 'view') return getViewLevel(actor, resource, channel) !== 'none'
  if (isOwner(actor, resource)) return true
  return isAdmin(actor) && ADMIN_FOREIGN_ACTIONS.has(action)
}

/** Nobody creates resources on behalf of another user. */
export function canCreateFor(actor: AccessActor, ownerId: number): boolean {
  return actor.id === ownerId
}
