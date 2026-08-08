import type { EmailSendLogEntry, EmailSendLogQuery, EmailSendLogStatus } from '~/api/email'
import { useEmailApi } from '~/api/email'

interface EmailSendLogFilters {
  accountId: string
  status: EmailSendLogStatus[]
  recipient: string
  search: string
  dateFrom: string
  dateTo: string
}

const PAGE_SIZE = 50

function createEmptyFilters(): EmailSendLogFilters {
  return { accountId: '', status: [], recipient: '', search: '', dateFrom: '', dateTo: '' }
}

export function useEmailSendLog() {
  const emailApi = useEmailApi()

  const entries = ref<EmailSendLogEntry[]>([])
  const total = ref(0)
  const offset = ref(0)
  const loading = ref(false)
  const error = ref<string | null>(null)
  const filters = ref<EmailSendLogFilters>(createEmptyFilters())
  // Normal users cannot read /api/email/accounts, so the account filter is built
  // from the accounts seen in the log itself and kept across filtered reloads.
  const knownAccounts = ref<{ id: string; name: string }[]>([])

  const hasMore = computed(() => entries.value.length < total.value)
  const hasActiveFilters = computed(() => {
    const f = filters.value
    return Boolean(f.accountId || f.status.length || f.recipient || f.search || f.dateFrom || f.dateTo)
  })

  function toQuery(): EmailSendLogQuery {
    const f = filters.value
    return {
      accountId: f.accountId || undefined,
      status: f.status.length ? f.status : undefined,
      recipient: f.recipient.trim() || undefined,
      search: f.search.trim() || undefined,
      dateFrom: f.dateFrom || undefined,
      dateTo: f.dateTo || undefined,
      limit: PAGE_SIZE,
    }
  }

  async function load(nextOffset = 0): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const page = await emailApi.listSendLog({ ...toQuery(), offset: nextOffset })
      entries.value = nextOffset === 0 ? page.entries : [...entries.value, ...page.entries]
      total.value = page.total
      offset.value = nextOffset
      rememberAccounts(page.entries)
    } catch (err) {
      error.value = (err as Error).message
    } finally {
      loading.value = false
    }
  }

  const fetchEntries = () => load(0)
  const loadMore = () => load(entries.value.length)

  function rememberAccounts(loaded: EmailSendLogEntry[]): void {
    const merged = new Map(knownAccounts.value.map(a => [a.id, a.name]))
    for (const entry of loaded) merged.set(entry.accountId, entry.accountName)
    knownAccounts.value = [...merged].map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  function resetFilters(): void {
    filters.value = createEmptyFilters()
    void fetchEntries()
  }

  function toggleStatus(status: EmailSendLogStatus): void {
    const current = filters.value.status
    filters.value.status = current.includes(status)
      ? current.filter(s => s !== status)
      : [...current, status]
    void fetchEntries()
  }

  return {
    entries,
    total,
    loading,
    error,
    filters,
    knownAccounts,
    hasMore,
    hasActiveFilters,
    fetchEntries,
    loadMore,
    resetFilters,
    toggleStatus,
  }
}
