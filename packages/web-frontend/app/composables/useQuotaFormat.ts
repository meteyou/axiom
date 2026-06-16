/**
 * Shared formatting helpers for Anthropic subscriber quota display.
 *
 * Centralises the colour thresholds and reset-time formatting used by both the
 * providers table and the global top bar so the two views stay consistent.
 * Date/time output follows the user's browser/OS regional settings (the
 * `undefined` locale), matching `useFormat`.
 */
export function useQuotaFormat() {
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
    const weekday = reset.toLocaleDateString(undefined, { weekday: 'short', timeZone })
    const time = reset
      .toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', timeZone })
      .replace(' ', '')
    return `${weekday} ${time}`
  }

  return {
    quotaColorClass,
    formatQuotaResetRelative,
    formatQuotaResetNice,
  }
}
