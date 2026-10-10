export const SETTINGS_TAB_IDS = [
  'agent',
  'memory',
  'agentHeartbeat',
  'healthMonitor',
  'imageGeneration',
  'telegram',
  'tasks',
  'tts',
  'stt',
  'secrets',
  'email',
] as const

export type SettingsTabId = (typeof SETTINGS_TAB_IDS)[number]

const USER_SETTINGS_TAB_IDS: readonly SettingsTabId[] = ['agent', 'email']

export function filterSettingsTabsByRole<T extends { id: SettingsTabId }>(tabs: T[], role: string | undefined): T[] {
  if (role === 'admin') return tabs
  return tabs.filter(tab => USER_SETTINGS_TAB_IDS.includes(tab.id))
}

/** Falls back to the Agent tab for unknown tabs and tabs the role may not see. */
export function resolveSettingsTab(raw: unknown, role: string | undefined): SettingsTabId {
  const candidate = (SETTINGS_TAB_IDS as readonly unknown[]).includes(raw) ? (raw as SettingsTabId) : 'agent'
  return role === 'admin' || USER_SETTINGS_TAB_IDS.includes(candidate) ? candidate : 'agent'
}
