import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import type { ProviderQuotaContract } from './contracts/providers.js'

export interface QuotaServiceLike {
  getSnapshot(): Record<string, ProviderQuotaContract>
  refreshProvider(providerId: string): Promise<ProviderQuotaContract | null>
}

export interface ProviderQuotaToolOptions {
  quotaService: QuotaServiceLike
}

export function createProviderQuotaTool(options: ProviderQuotaToolOptions): AgentTool {
  return {
    name: 'provider_quota',
    label: 'Provider Quota',
    description:
      'Check the current subscriber usage quota for LLM providers (Anthropic Claude Pro/Max, ChatGPT Codex, OpenCode, etc.). ' +
      'Returns normalized usage windows with utilization percentages and reset times. ' +
      'Use this to answer questions about remaining quota, rate limits, or usage consumption per provider.',
    parameters: Type.Object({
      providerId: Type.Optional(
        Type.String({
          description: 'A specific provider id to check. Omit to get quota for all providers.',
        }),
      ),
      refresh: Type.Optional(
        Type.Boolean({
          description: 'Force a live quota fetch before returning (default: false). Uses cached data when omitted.',
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const { providerId, refresh = false } = params as { providerId?: string; refresh?: boolean }

      try {
        if (providerId && refresh) {
          const quota = await options.quotaService.refreshProvider(providerId)
          if (!quota) {
            return {
              content: [{ type: 'text' as const, text: `No quota data available for provider "${providerId}". The provider may not exist or may not support quota monitoring.` }],
              details: { error: true, providerId },
            }
          }
          const formatted = formatProviderQuota(providerId, quota)
          return {
            content: [{ type: 'text' as const, text: formatted }],
            details: { providerId, refreshed: true, quota },
          }
        }

        const snapshot = options.quotaService.getSnapshot()
        const entries = providerId
          ? Object.entries(snapshot).filter(([id]) => id === providerId)
          : Object.entries(snapshot)

        if (entries.length === 0) {
          const scope = providerId ? ` for provider "${providerId}"` : ''
          return {
            content: [{ type: 'text' as const, text: `No quota data available${scope}. No quota-capable providers are configured, or no data has been fetched yet.` }],
            details: { providerId, count: 0 },
          }
        }

        const formatted = entries.map(([id, quota]) => formatProviderQuota(id, quota)).join('\n\n')
        return {
          content: [{ type: 'text' as const, text: formatted }],
          details: {
            providerId,
            refreshed: false,
            count: entries.length,
            snapshot: Object.fromEntries(entries),
          },
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: 'text' as const, text: `Error fetching quota data: ${message}` }],
          details: { error: true, providerId },
        }
      }
    },
  }
}

function formatProviderQuota(providerId: string, quota: ProviderQuotaContract): string {
  const header = `**${providerId}** (${quota.kind})`
  if (quota.error) {
    return `${header}\nError: ${quota.error}\nFetched: ${quota.fetchedAt}`
  }

  if (!quota.windows || quota.windows.length === 0) {
    return `${header}\nNo usage windows available.\nFetched: ${quota.fetchedAt}`
  }

  const lines = quota.windows.map(w => {
    const pct = `${w.utilization}%`
    const reset = w.resetsAt ? ` (resets ${w.resetsAt})` : ''
    return `  - ${w.label}: ${pct} used${reset}`
  })

  return [header, ...lines, `Fetched: ${quota.fetchedAt}`].join('\n')
}
