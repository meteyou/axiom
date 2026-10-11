import type { ContextUsageInfo } from '@axiom/core/contracts'

export function useChatApi() {
  const { apiFetch } = useApi()

  const getContextUsage = () => apiFetch<{ usage: ContextUsageInfo | null }>('/api/chat/context')

  return { getContextUsage }
}
