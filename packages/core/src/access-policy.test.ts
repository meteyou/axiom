import { describe, expect, it } from 'vitest'
import { can, canCreateFor, getViewLevel } from './access-policy.js'
import type { AccessAction, AccessResourceKind } from './access-policy.js'

const owner = { id: 2, role: 'user' }
const other = { id: 3, role: 'user' }
const admin = { id: 1, role: 'admin' }
const ownerAdmin = { id: 1, role: 'admin' }

function task(ownerId: number) {
  return { kind: 'task' as const, ownerId }
}
function cronjob(ownerId: number) {
  return { kind: 'cronjob' as const, ownerId }
}

describe('AccessPolicy', () => {
  it.each(['ui', 'agent'] as const)('lets the owner do everything on own resources (%s)', (channel) => {
    const taskActions: AccessAction[] = ['view', 'stop', 'delete', 'restart', 'resume']
    const cronActions: AccessAction[] = ['view', 'delete', 'toggle', 'edit', 'trigger']
    for (const action of taskActions) expect(can(owner, task(2), action, channel)).toBe(true)
    for (const action of cronActions) expect(can(owner, cronjob(2), action, channel)).toBe(true)
    expect(getViewLevel(owner, task(2), channel)).toBe('full')
    expect(can(ownerAdmin, task(1), 'restart', channel)).toBe(true)
  })

  it.each(['ui', 'agent'] as const)('denies another regular user everything (%s)', (channel) => {
    for (const action of ['view', 'stop', 'delete', 'restart', 'resume'] as const) {
      expect(can(other, task(2), action, channel)).toBe(false)
    }
    for (const action of ['view', 'delete', 'toggle', 'edit', 'trigger'] as const) {
      expect(can(other, cronjob(2), action, channel)).toBe(false)
    }
    expect(getViewLevel(other, task(2), channel)).toBe('none')
  })

  it('shows an admin foreign resources fully in the UI but only as metadata through the agent', () => {
    expect(getViewLevel(admin, task(2), 'ui')).toBe('full')
    expect(getViewLevel(admin, task(2), 'agent')).toBe('metadata')
    expect(can(admin, task(2), 'view', 'ui')).toBe(true)
    expect(can(admin, task(2), 'view', 'agent')).toBe(true)
  })

  it.each(['ui', 'agent'] as const)('lets an admin stop and delete foreign tasks but not restart or resume them (%s)', (channel) => {
    expect(can(admin, task(2), 'stop', channel)).toBe(true)
    expect(can(admin, task(2), 'delete', channel)).toBe(true)
    expect(can(admin, task(2), 'restart', channel)).toBe(false)
    expect(can(admin, task(2), 'resume', channel)).toBe(false)
  })

  it.each(['ui', 'agent'] as const)('lets an admin only toggle and delete foreign cronjobs (%s)', (channel) => {
    expect(can(admin, cronjob(2), 'toggle', channel)).toBe(true)
    expect(can(admin, cronjob(2), 'delete', channel)).toBe(true)
    expect(can(admin, cronjob(2), 'edit', channel)).toBe(false)
    expect(can(admin, cronjob(2), 'trigger', channel)).toBe(false)
  })

  it('rejects actions that do not apply to the resource kind', () => {
    const kinds: AccessResourceKind[] = ['task', 'cronjob']
    expect(kinds).toHaveLength(2)
    expect(can(owner, task(2), 'toggle', 'ui')).toBe(false)
    expect(can(owner, cronjob(2), 'stop', 'ui')).toBe(false)
  })

  it('treats ownerless resources as nobody\'s own', () => {
    expect(can(owner, { kind: 'task', ownerId: null }, 'view', 'ui')).toBe(false)
    expect(can(admin, { kind: 'task', ownerId: null }, 'stop', 'ui')).toBe(true)
  })

  it('only allows creating resources for oneself', () => {
    expect(canCreateFor(owner, 2)).toBe(true)
    expect(canCreateFor(admin, 2)).toBe(false)
  })
})
