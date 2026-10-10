import type {
  AgentCore,
  Database,
  HealthMonitorNotificationTogglesContract,
  SettingsStorageContract,
  TelegramSettingsStorageContract,
} from '@axiom/core'

export type HealthMonitorNotificationToggles = HealthMonitorNotificationTogglesContract

export type SettingsData = SettingsStorageContract & {
  sessionTimeoutMinutes: number
  language: string
  timezone: string
  healthMonitorIntervalMinutes: number
}

export type TelegramData = TelegramSettingsStorageContract & {
  enabled: boolean
  botToken: string
  adminUserIds: number[]
  pollingMode: boolean
  webhookUrl: string
  sendVoiceReply: boolean
  sendStallWarnings: boolean
}

export interface SettingsRouterOptions {
  db?: Database
  onActiveProviderChanged?: () => void
  getAgentCore?: () => AgentCore | null
  /** `null` means the global timezone changed; otherwise the timezone of that user. */
  onTimezoneChanged?: (userId: number | null) => void
  onHealthMonitorSettingsChanged?: () => void
  onConsolidationSettingsChanged?: () => void
  onAgentHeartbeatSettingsChanged?: () => void
  onTelegramSettingsChanged?: () => void
  /** Background tools are built once, so they must be rebuilt for `generate_image` to follow the settings. */
  onImageGenerationSettingsChanged?: () => void
}
