export interface MemoryFact {
  id: number
  userId: number | null
  sessionId: string | null
  content: string
  source: string
  timestamp: string
}

export interface LoadMemoryFactsOptions {
  query?: string
  userId?: number
  dateFrom?: string
  dateTo?: string
  limit?: number
  offset?: number
}

export function useMemoryFacts() {
  const { apiFetch } = useApi()

  const loading = ref(false)
  const saving = ref(false)
  const error = ref<string | null>(null)

  async function loadFacts(options: LoadMemoryFactsOptions = {}): Promise<{ facts: MemoryFact[]; total: number }> {
    loading.value = true
    error.value = null

    try {
      const params = new URLSearchParams()

      if (options.query?.trim()) params.set('query', options.query.trim())
      if (options.userId !== undefined) params.set('userId', String(options.userId))
      if (options.dateFrom) params.set('dateFrom', options.dateFrom)
      if (options.dateTo) params.set('dateTo', options.dateTo)
      if (options.limit !== undefined) params.set('limit', String(options.limit))
      if (options.offset !== undefined) params.set('offset', String(options.offset))

      const query = params.toString()
      return await apiFetch<{ facts: MemoryFact[]; total: number }>(`/api/memory/facts${query ? `?${query}` : ''}`)
    } catch (err) {
      error.value = (err as Error).message
      return { facts: [], total: 0 }
    } finally {
      loading.value = false
    }
  }

  async function updateFact(id: number, content: string): Promise<boolean> {
    saving.value = true
    error.value = null

    try {
      await apiFetch(`/api/memory/facts/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ content }),
      })
      return true
    } catch (err) {
      error.value = (err as Error).message
      return false
    } finally {
      saving.value = false
    }
  }

  async function deleteFact(id: number): Promise<boolean> {
    saving.value = true
    error.value = null

    try {
      await apiFetch(`/api/memory/facts/${id}`, {
        method: 'DELETE',
      })
      return true
    } catch (err) {
      error.value = (err as Error).message
      return false
    } finally {
      saving.value = false
    }
  }

  return {
    loading,
    saving,
    error,
    loadFacts,
    updateFact,
    deleteFact,
  }
}
