export interface MemoryDailyFile {
  filename: string
  date: string
  size: number
  modifiedAt: string
}

export interface MemoryProjectFile {
  filename: string
  name: string
  size: number
  modifiedAt: string
}

export interface MemoryWikiFile {
  filename: string
  name: string
  title: string
  aliases: string[]
  size: number
  modifiedAt: string
}

export interface MemoryProfileResponse {
  content: string
  username: string
}

export interface MemoryFact {
  id: number
  userId: number | null
  sessionId: string | null
  content: string
  source: string
  timestamp: string
}

export interface MemoryFactsQuery {
  query?: string
  userId?: number
  dateFrom?: string
  dateTo?: string
  limit?: number
  offset?: number
}

export interface MemoryFactsResponse {
  facts: MemoryFact[]
  total: number
}

export function useMemoryApi() {
  const { apiFetch } = useApi()

  const getSoul = () => apiFetch<{ content: string }>('/api/memory/soul')
  const updateSoul = (content: string) => apiFetch('/api/memory/soul', {
    method: 'PUT',
    body: JSON.stringify({ content }),
  })

  const getCoreMemory = () => apiFetch<{ content: string }>('/api/memory/core')
  const updateCoreMemory = (content: string) => apiFetch('/api/memory/core', {
    method: 'PUT',
    body: JSON.stringify({ content }),
  })

  const getAgentRules = () => apiFetch<{ content: string }>('/api/memory/agents')
  const updateAgentRules = (content: string) => apiFetch('/api/memory/agents', {
    method: 'PUT',
    body: JSON.stringify({ content }),
  })
  const getDefaultAgentRules = () => apiFetch<{ content: string }>('/api/memory/agents/default')

  const listDailyFiles = () => apiFetch<{ files: MemoryDailyFile[] }>('/api/memory/daily')
  const getDailyFile = (date: string) => apiFetch<{ content: string }>(`/api/memory/daily/${date}`)
  const updateDailyFile = (date: string, content: string) => apiFetch(`/api/memory/daily/${date}`, {
    method: 'PUT',
    body: JSON.stringify({ content }),
  })

  const listWikiPages = () => apiFetch<{ files: MemoryWikiFile[] }>('/api/memory/wiki')
  const getWikiPage = (name: string) => apiFetch<{ content: string }>(`/api/memory/wiki/${name}`)
  const updateWikiPage = (name: string, content: string) => apiFetch(`/api/memory/wiki/${name}`, {
    method: 'PUT',
    body: JSON.stringify({ content }),
  })
  const deleteWikiPage = (name: string) => apiFetch(`/api/memory/wiki/${name}`, {
    method: 'DELETE',
  })

  const getHeartbeat = () => apiFetch<{ content: string }>('/api/memory/heartbeat')
  const updateHeartbeat = (content: string) => apiFetch('/api/memory/heartbeat', {
    method: 'PUT',
    body: JSON.stringify({ content }),
  })
  const getDefaultHeartbeat = () => apiFetch<{ content: string }>('/api/memory/heartbeat/default')

  const getConsolidationRules = () => apiFetch<{ content: string }>('/api/memory/consolidation-rules')
  const updateConsolidationRules = (content: string) => apiFetch('/api/memory/consolidation-rules', {
    method: 'PUT',
    body: JSON.stringify({ content }),
  })
  const getDefaultConsolidationRules = () => apiFetch<{ content: string }>('/api/memory/consolidation-rules/default')

  const getProfile = () => apiFetch<MemoryProfileResponse>('/api/memory/profile')
  const updateProfile = (content: string) => apiFetch('/api/memory/profile', {
    method: 'PUT',
    body: JSON.stringify({ content }),
  })

  const listProjectFiles = () => apiFetch<{ files: MemoryProjectFile[] }>('/api/memory/projects')
  const getProjectFile = (name: string) => apiFetch<{ content: string }>(`/api/memory/projects/${name}`)
  const updateProjectFile = (name: string, content: string) => apiFetch(`/api/memory/projects/${name}`, {
    method: 'PUT',
    body: JSON.stringify({ content }),
  })

  const listFacts = (queryOptions: MemoryFactsQuery = {}) => {
    const params = new URLSearchParams()

    if (queryOptions.query?.trim()) params.set('query', queryOptions.query.trim())
    if (queryOptions.userId !== undefined) params.set('userId', String(queryOptions.userId))
    if (queryOptions.dateFrom) params.set('dateFrom', queryOptions.dateFrom)
    if (queryOptions.dateTo) params.set('dateTo', queryOptions.dateTo)
    if (queryOptions.limit !== undefined) params.set('limit', String(queryOptions.limit))
    if (queryOptions.offset !== undefined) params.set('offset', String(queryOptions.offset))

    const query = params.toString()
    return apiFetch<MemoryFactsResponse>(`/api/memory/facts${query ? `?${query}` : ''}`)
  }

  const updateFact = (id: number, content: string) => apiFetch(`/api/memory/facts/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ content }),
  })

  const deleteFact = (id: number) => apiFetch(`/api/memory/facts/${id}`, {
    method: 'DELETE',
  })

  return {
    getSoul,
    updateSoul,
    getCoreMemory,
    updateCoreMemory,
    getAgentRules,
    updateAgentRules,
    getDefaultAgentRules,
    listDailyFiles,
    getDailyFile,
    updateDailyFile,
    listWikiPages,
    getWikiPage,
    updateWikiPage,
    deleteWikiPage,
    getHeartbeat,
    updateHeartbeat,
    getDefaultHeartbeat,
    getConsolidationRules,
    updateConsolidationRules,
    getDefaultConsolidationRules,
    getProfile,
    updateProfile,
    listProjectFiles,
    getProjectFile,
    updateProjectFile,
    listFacts,
    updateFact,
    deleteFact,
  }
}
