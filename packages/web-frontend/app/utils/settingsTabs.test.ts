import { describe, expect, it } from 'vitest'
import { filterSettingsTabsByRole, resolveSettingsTab } from './settingsTabs'

const tabs = [
  { id: 'agent' as const },
  { id: 'agentHeartbeat' as const },
  { id: 'telegram' as const },
  { id: 'secrets' as const },
]

describe('filterSettingsTabsByRole', () => {
  it('shows every tab to admins', () => {
    expect(filterSettingsTabsByRole(tabs, 'admin')).toEqual(tabs)
  })

  it('shows regular users only the Agent and Email tabs', () => {
    expect(filterSettingsTabsByRole([...tabs, { id: 'email' as const }], 'user')).toEqual([{ id: 'agent' }, { id: 'email' }])
  })

  it('treats a missing role like a regular user', () => {
    expect(filterSettingsTabsByRole(tabs, undefined)).toEqual([{ id: 'agent' }])
  })
})

describe('resolveSettingsTab', () => {
  it('keeps a tab the role may see', () => {
    expect(resolveSettingsTab('telegram', 'admin')).toBe('telegram')
    expect(resolveSettingsTab('agent', 'user')).toBe('agent')
    expect(resolveSettingsTab('email', 'user')).toBe('email')
  })

  it('falls back to Agent for hidden or unknown tabs', () => {
    expect(resolveSettingsTab('telegram', 'user')).toBe('agent')
    expect(resolveSettingsTab('bogus', 'admin')).toBe('agent')
    expect(resolveSettingsTab(undefined, 'admin')).toBe('agent')
  })
})
