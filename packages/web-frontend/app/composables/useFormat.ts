/**
 * Shared formatting utilities.
 *
 * Centralises Intl-based formatters so every page uses the same locale-aware
 * output without duplicating the logic.
 */
export function useFormat() {
  const { locale } = useI18n()

  /** Locale-aware number: 1 234 567 */
  function formatNumber(value: number): string {
    return new Intl.NumberFormat(locale.value).format(value)
  }

  /** Locale-aware currency (USD): $1,234.56 */
  function formatCurrency(value: number): string {
    return new Intl.NumberFormat(locale.value, {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    }).format(value)
  }

  /** Medium date + short time: "Mar 28, 2026, 2:30 PM" */
  function formatDateTime(value: string): string {
    return new Intl.DateTimeFormat(locale.value, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(value))
  }

  /** Medium date only: "Mar 28, 2026" */
  function formatDate(value: string): string {
    return new Intl.DateTimeFormat(locale.value, {
      dateStyle: 'medium',
    }).format(new Date(value))
  }

  /** Compact timestamp for log rows: "Mar 28, 14:30:05" */
  function formatTimestamp(ts: string): string {
    if (!ts) return ''
    const d = new Date(ts + (ts.includes('Z') || ts.includes('+') ? '' : 'Z'))
    return d.toLocaleString(locale.value, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  }

  /** Human-friendly duration: "120ms" or "1.2s" */
  function formatDuration(ms: number | null | undefined): string {
    if (ms == null) return '—'
    if (ms < 1000) return `${ms}ms`
    return `${(ms / 1000).toFixed(1)}s`
  }

  return {
    formatNumber,
    formatCurrency,
    formatDateTime,
    formatDate,
    formatTimestamp,
    formatDuration,
  }
}
