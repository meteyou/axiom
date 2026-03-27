interface User {
  id: number
  username: string
  role: string
}

interface LoginResponse {
  accessToken: string
  refreshToken: string
  user: User
}

const TOKEN_KEY = 'openagent_access_token'
const REFRESH_TOKEN_KEY = 'openagent_refresh_token'
const USER_KEY = 'openagent_user'

export function useAuth() {
  const user = useState<User | null>('auth_user', () => {
    if (import.meta.client) {
      const stored = localStorage.getItem(USER_KEY)
      if (stored) {
        try {
          return JSON.parse(stored)
        } catch {
          localStorage.removeItem(USER_KEY)
          localStorage.removeItem(TOKEN_KEY)
          localStorage.removeItem(REFRESH_TOKEN_KEY)
          return null
        }
      }
    }
    return null
  })

  const accessToken = useState<string | null>('auth_token', () => {
    if (import.meta.client) {
      return localStorage.getItem(TOKEN_KEY)
    }
    return null
  })

  const isAuthenticated = computed(() => !!accessToken.value)

  function setAuth(data: LoginResponse) {
    accessToken.value = data.accessToken
    user.value = data.user
    localStorage.setItem(TOKEN_KEY, data.accessToken)
    localStorage.setItem(REFRESH_TOKEN_KEY, data.refreshToken)
    localStorage.setItem(USER_KEY, JSON.stringify(data.user))
  }

  function clearAuth() {
    accessToken.value = null
    user.value = null
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(REFRESH_TOKEN_KEY)
    localStorage.removeItem(USER_KEY)
  }

  function getAccessToken(): string | null {
    return accessToken.value
  }

  function getRefreshToken(): string | null {
    if (import.meta.client) {
      return localStorage.getItem(REFRESH_TOKEN_KEY)
    }
    return null
  }

  async function refreshAccessToken(): Promise<boolean> {
    const refresh = getRefreshToken()
    if (!refresh) return false

    try {
      const config = useRuntimeConfig()
      const res = await fetch(`${config.public.apiBase}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: refresh }),
      })

      if (!res.ok) return false

      const data = (await res.json()) as LoginResponse
      setAuth(data)
      return true
    } catch {
      return false
    }
  }

  async function login(username: string, password: string): Promise<{ success: boolean; error?: string }> {
    try {
      const config = useRuntimeConfig()
      const res = await fetch(`${config.public.apiBase}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })

      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        return { success: false, error: (body as { error?: string }).error || 'Login failed' }
      }

      const data = (await res.json()) as LoginResponse
      setAuth(data)
      return { success: true }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  }

  function logout() {
    clearAuth()
    navigateTo('/login')
  }

  return {
    user,
    accessToken,
    isAuthenticated,
    login,
    logout,
    getAccessToken,
    refreshAccessToken,
  }
}
