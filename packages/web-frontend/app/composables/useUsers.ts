export interface User {
  id: number
  username: string
  role: string
  telegramId: string | null
  createdAt: string
  updatedAt: string
}

export function useUsers() {
  const { apiFetch } = useApi()
  const { setAuth } = useAuth()

  const users = ref<User[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)

  async function fetchUsers(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const data = await apiFetch<{ users: User[] }>('/api/users')
      users.value = data.users
    } catch (err) {
      error.value = (err as Error).message
    } finally {
      loading.value = false
    }
  }

  async function createUser(username: string, password: string, role: string, language?: string, timezone?: string): Promise<boolean> {
    error.value = null
    try {
      await apiFetch('/api/users', {
        method: 'POST',
        body: JSON.stringify({ username, password, role, language, timezone }),
      })
      await fetchUsers()
      return true
    } catch (err) {
      error.value = (err as Error).message
      return false
    }
  }

  async function updateUser(id: number, updates: { role?: string; password?: string }): Promise<boolean> {
    error.value = null
    try {
      await apiFetch(`/api/users/${id}`, {
        method: 'PUT',
        body: JSON.stringify(updates),
      })
      await fetchUsers()
      return true
    } catch (err) {
      error.value = (err as Error).message
      return false
    }
  }

  /** Resolves to the folders the backend kept on disk, or null on failure. */
  async function deleteUser(id: number, deleteFiles = true): Promise<{ keptFolders: string[] } | null> {
    error.value = null
    try {
      const data = await apiFetch<{ keptFolders?: string[] }>(`/api/users/${id}?deleteFiles=${deleteFiles}`, {
        method: 'DELETE',
      })
      await fetchUsers()
      return { keptFolders: data.keptFolders ?? [] }
    } catch (err) {
      error.value = (err as Error).message
      return null
    }
  }

  async function changeOwnPassword(currentPassword: string, newPassword: string): Promise<boolean> {
    error.value = null
    try {
      const data = await apiFetch<Parameters<typeof setAuth>[0]>('/api/users/me/password', {
        method: 'PUT',
        body: JSON.stringify({ currentPassword, newPassword }),
      })
      setAuth(data)
      return true
    } catch (err) {
      error.value = (err as Error).message
      return false
    }
  }

  return {
    users,
    loading,
    error,
    fetchUsers,
    createUser,
    updateUser,
    deleteUser,
    changeOwnPassword,
  }
}
