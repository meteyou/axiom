import type { Ref } from 'vue'
import type { ContextUsageInfo } from '@axiom/core/contracts'
import { useChatApi } from '~/api/chat'

/**
 * Context-window usage of the main agent, refetched whenever `revision`
 * changes (turn end, compaction, new session, reconnect).
 */
export function useContextUsage(revision: Ref<number>) {
  const chatApi = useChatApi()
  const usage = ref<ContextUsageInfo | null>(null)
  let pending = 0

  async function refresh() {
    const request = ++pending
    try {
      const result = await chatApi.getContextUsage()
      if (request === pending) usage.value = result.usage
    } catch (err) {
      // The meter is secondary information; hide it instead of showing stale numbers.
      console.warn('[chat] Failed to load context usage:', err)
      if (request === pending) usage.value = null
    }
  }

  watch(revision, () => { void refresh() }, { immediate: true })

  return { usage }
}
