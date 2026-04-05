export function useApi() {
  const { getAccessToken, refreshAccessToken, logout } = useAuth()
  const config = useRuntimeConfig()

  async function apiFetch<T>(
    path: string,
    options: RequestInit = {}
  ): Promise<T> {
    const token = getAccessToken()

    const isFormData = options.body instanceof FormData
    const headers: Record<string, string> = {
      ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
      ...(options.headers as Record<string, string> || {}),
    }

    if (token) {
      headers['Authorization'] = `Bearer ${token}`
    }

    let res = await fetch(`${config.public.apiBase}${path}`, {
      ...options,
      headers,
    })

    // On 401, try refreshing the token
    if (res.status === 401 && token) {
      const refreshed = await refreshAccessToken()
      if (refreshed) {
        const newToken = getAccessToken()
        if (newToken) {
          headers['Authorization'] = `Bearer ${newToken}`
        }
        res = await fetch(`${config.public.apiBase}${path}`, {
          ...options,
          headers,
        })
      } else {
        logout()
        throw new Error('Session expired')
      }
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error((body as { error?: string }).error || `API error: ${res.status}`)
    }

    return res.json() as Promise<T>
  }

  return { apiFetch }
}
