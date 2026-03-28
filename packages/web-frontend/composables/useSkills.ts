export interface Skill {
  id: string
  owner: string
  name: string
  description: string
  source: string
  sourceUrl: string
  path: string
  enabled: boolean
  envKeys?: string[]
  emoji?: string
}

export interface BuiltinToolsConfig {
  webSearch: {
    enabled: boolean
    provider: 'duckduckgo' | 'brave' | 'searxng'
  }
  webFetch: {
    enabled: boolean
  }
}

interface SkillsResponse {
  skills: Skill[]
}

interface BuiltinToolsResponse {
  builtinTools: BuiltinToolsConfig
  braveSearchApiKey: string
  searxngUrl: string
}

interface SkillMutationResponse {
  skill: Skill
}

export function useSkills() {
  const { apiFetch } = useApi()

  const skills = useState<Skill[]>('skills_list', () => [])
  const builtinTools = useState<BuiltinToolsConfig>('skills_builtin_tools', () => ({
    webSearch: { enabled: true, provider: 'duckduckgo' },
    webFetch: { enabled: true },
  }))
  const braveSearchApiKey = useState<string>('skills_brave_api_key', () => '')
  const searxngUrl = useState<string>('skills_searxng_url', () => '')
  const loading = useState<boolean>('skills_loading', () => false)
  const error = useState<string | null>('skills_error', () => null)
  const installing = useState<boolean>('skills_installing', () => false)

  async function fetchSkills(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const data = await apiFetch<SkillsResponse>('/api/skills')
      skills.value = data.skills
    } catch (err) {
      error.value = (err as Error).message
    } finally {
      loading.value = false
    }
  }

  async function fetchBuiltinTools(): Promise<void> {
    error.value = null
    try {
      const data = await apiFetch<BuiltinToolsResponse>('/api/skills/builtin')
      builtinTools.value = data.builtinTools
      braveSearchApiKey.value = data.braveSearchApiKey
      searxngUrl.value = data.searxngUrl
    } catch (err) {
      error.value = (err as Error).message
    }
  }

  async function installSkill(source: string): Promise<Skill | null> {
    installing.value = true
    error.value = null
    try {
      const data = await apiFetch<SkillMutationResponse>('/api/skills/install', {
        method: 'POST',
        body: JSON.stringify({ source }),
      })
      await fetchSkills()
      return data.skill
    } catch (err) {
      error.value = (err as Error).message
      return null
    } finally {
      installing.value = false
    }
  }

  async function updateSkill(id: string, input: {
    enabled?: boolean
    envValues?: Record<string, string>
    envKeys?: string[]
  }): Promise<Skill | null> {
    error.value = null
    try {
      const [owner, name] = id.split('/')
      const data = await apiFetch<SkillMutationResponse>(`/api/skills/${owner}/${name}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      })
      await fetchSkills()
      return data.skill
    } catch (err) {
      error.value = (err as Error).message
      return null
    }
  }

  async function deleteSkill(id: string): Promise<boolean> {
    error.value = null
    try {
      const [owner, name] = id.split('/')
      await apiFetch(`/api/skills/${owner}/${name}`, { method: 'DELETE' })
      await fetchSkills()
      return true
    } catch (err) {
      error.value = (err as Error).message
      return false
    }
  }

  async function updateBuiltinTools(input: {
    builtinTools?: Partial<BuiltinToolsConfig>
    braveSearchApiKey?: string
    searxngUrl?: string
  }): Promise<boolean> {
    error.value = null
    try {
      const data = await apiFetch<BuiltinToolsResponse>('/api/skills/builtin', {
        method: 'PATCH',
        body: JSON.stringify(input),
      })
      builtinTools.value = data.builtinTools
      braveSearchApiKey.value = data.braveSearchApiKey
      searxngUrl.value = data.searxngUrl
      return true
    } catch (err) {
      error.value = (err as Error).message
      return false
    }
  }

  function clearError() {
    error.value = null
  }

  return {
    skills,
    builtinTools,
    braveSearchApiKey,
    searxngUrl,
    loading,
    error,
    installing,
    fetchSkills,
    fetchBuiltinTools,
    installSkill,
    updateSkill,
    deleteSkill,
    updateBuiltinTools,
    clearError,
  }
}
