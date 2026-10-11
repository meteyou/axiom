import type { SettingsThinkingLevel, SettingsContract, SettingsUpdateContract, TtsSettingsContract } from '@axiom/core/contracts'

interface ConsolidationRunResult {
  updated: boolean
  reason?: string
}

interface ConsolidationStatus {
  lastRun: string | null
  lastResult: ConsolidationRunResult | null
}

interface TtsPreviewPayload {
  text: string
  settings: Pick<
    TtsSettingsContract,
    'provider' | 'providerId' | 'openaiModel' | 'openaiVoice' | 'openaiInstructions' | 'mistralVoice' | 'responseFormat'
  >
}

export interface ChatModelRef {
  providerId: string
  modelId: string
}

export interface OwnSettings {
  scope: 'personal' | 'global'
  overrides: {
    chatModel: ChatModelRef | null
    thinkingLevel: SettingsThinkingLevel | null
    language: string | null
    timezone: string | null
  }
  defaults: {
    chatModel: (ChatModelRef & { providerName: string | null }) | null
    thinkingLevel: SettingsThinkingLevel
    language: string
    timezone: string
  }
  effective: {
    chatModel: ChatModelRef | null
    thinkingLevel: SettingsThinkingLevel
    language: string
    timezone: string
  }
}

export type OwnSettingsUpdate = Partial<OwnSettings['overrides']>

export interface SelectableChatProvider {
  id: string
  name: string
  providerType: string
  models: { id: string; name: string }[]
}

export function useSettingsApi() {
  const { apiFetch, getAuthHeaders } = useApi()
  const config = useRuntimeConfig()

  const getSettings = () => apiFetch<Partial<SettingsContract>>('/api/settings')

  const updateSettings = (updates: Partial<SettingsUpdateContract>) => apiFetch<Partial<SettingsContract> & { message: string }>('/api/settings', {
    method: 'PUT',
    body: JSON.stringify(updates),
  })

  const getOwnSettings = () => apiFetch<OwnSettings>('/api/settings/me')

  const updateOwnSettings = (updates: OwnSettingsUpdate) => apiFetch<OwnSettings>('/api/settings/me', {
    method: 'PUT',
    body: JSON.stringify(updates),
  })

  const getChatModels = () => apiFetch<{ providers: SelectableChatProvider[] }>('/api/settings/chat-models')

  const getConsolidationStatus = () => apiFetch<ConsolidationStatus>('/api/memory/consolidation/status')

  const runConsolidation = () => apiFetch<ConsolidationRunResult>('/api/memory/consolidation/run', {
    method: 'POST',
  })

  async function previewTts(payload: TtsPreviewPayload): Promise<Blob> {
    const response = await fetch(`${config.public.apiBase}/api/tts/preview`, {
      method: 'POST',
      headers: {
        ...getAuthHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    })

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' })) as { error?: string }
      throw new Error(error.error ?? `HTTP ${response.status}`)
    }

    return response.blob()
  }

  return {
    getSettings,
    updateSettings,
    getOwnSettings,
    updateOwnSettings,
    getChatModels,
    getConsolidationStatus,
    runConsolidation,
    previewTts,
  }
}
