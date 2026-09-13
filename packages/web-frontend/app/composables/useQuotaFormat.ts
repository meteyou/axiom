import type { ProviderQuotaBalanceContract, ProviderQuotaWindowContract } from '@axiom/core/contracts'

export interface QuotaDisplayPart {
  key: string
  label: string
  /** Rendered value: `42%` for usage windows, `$8.97` for credit balances. */
  value: string
  colorClass: string
  reset: string
}

/**
 * Shared formatting helpers for subscriber usage quota display.
 *
 * Centralises the colour thresholds and reset-time formatting used by both the
 * providers table and the global top bar so the two views stay consistent
 * across every quota provider (Anthropic, OpenAI Codex, …). Date/time output
 * follows the user's browser/OS regional settings (the `undefined` locale),
 * matching `useFormat`.
 */
export function useQuotaFormat() {
  const { t } = useI18n()

  function quotaColorClass(utilization: number): string {
    if (utilization >= 90) return 'text-destructive'
    if (utilization >= 70) return 'text-amber-600 dark:text-amber-500'
    return 'text-emerald-600 dark:text-emerald-500'
  }

  function formatQuotaResetRelative(resetsAt: string | null): string {
    if (!resetsAt) return ''
    const diffMs = new Date(resetsAt).getTime() - Date.now()
    if (Number.isNaN(diffMs) || diffMs <= 0) return 'now'

    const hours = Math.floor(diffMs / (1000 * 60 * 60))
    const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60))
    if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`
    if (hours > 0) return `${hours}h ${minutes}m`
    return `${minutes}m`
  }

  function formatQuotaResetNice(resetsAt: string | null): string {
    if (!resetsAt) return ''
    const reset = new Date(resetsAt)
    if (Number.isNaN(reset.getTime())) return ''

    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
    const time = reset
      .toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', timeZone })
      .replace(' ', '')

    // The bare weekday is only unambiguous within the next week. For resets
    // further out (e.g. the 30d window) add the date so "Fr" can't refer to an
    // arbitrary Friday weeks away.
    const aWeekMs = 7 * 24 * 60 * 60 * 1000
    if (reset.getTime() - Date.now() >= aWeekMs) {
      const date = reset.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit', timeZone })
      return `${date} ${time}`
    }

    const weekday = reset.toLocaleDateString(undefined, { weekday: 'short', timeZone })
    return `${weekday} ${time}`
  }

  /**
   * Map a normalized quota snapshot into ready-to-render display parts. Each
   * window renders its own reset time according to its `resetDisplay` hint
   * (relative countdown vs. absolute weekday/time).
   */
  function quotaWindowParts(quota: {
    windows: readonly ProviderQuotaWindowContract[]
    balance?: ProviderQuotaBalanceContract | null
  }): QuotaDisplayPart[] {
    if (quota.balance) return [quotaBalancePart(quota.balance)]
    return quota.windows.map((window) => ({
      key: window.key,
      label: window.label,
      value: `${window.utilization}%`,
      colorClass: quotaColorClass(window.utilization),
      reset:
        window.resetDisplay === 'absolute'
          ? formatQuotaResetNice(window.resetsAt)
          : formatQuotaResetRelative(window.resetsAt),
    }))
  }

  function formatCurrency(amount: number, currency: string): string {
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 2 }).format(amount)
    } catch {
      return `${amount.toFixed(2)} ${currency}`
    }
  }

  function quotaBalancePart(balance: ProviderQuotaBalanceContract): QuotaDisplayPart {
    return {
      key: 'balance',
      label: t('providers.quota.credits'),
      value: formatCurrency(balance.available, balance.currency),
      colorClass: balance.available <= 0 ? 'text-destructive' : 'text-emerald-600 dark:text-emerald-500',
      reset: typeof balance.periodSpent === 'number'
        ? t('providers.quota.periodSpent', { amount: formatCurrency(balance.periodSpent, balance.currency) })
        : '',
    }
  }

  return {
    quotaColorClass,
    formatCurrency,
    formatQuotaResetRelative,
    formatQuotaResetNice,
    quotaWindowParts,
  }
}
