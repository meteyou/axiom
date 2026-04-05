/**
 * Global connection & provider health status.
 *
 * Polls /api/health periodically and exposes a combined status
 * for the header status indicator:
 *   - 'offline'   → backend unreachable (grey dot)
 *   - 'degraded'  → backend OK but provider degraded (orange dot)
 *   - 'healthy'   → backend OK and provider healthy (green dot)
 */

export type GlobalStatus = 'offline' | 'degraded' | 'healthy'
type OperatingMode = 'normal' | 'fallback'

interface HealthSnapshot {
  operatingMode?: OperatingMode
  provider: {
    name: string
    status: string
  } | null
  fallbackProvider?: {
    name: string
    model: string
  } | null
}

const POLL_INTERVAL_MS = 30_000

export function useConnectionStatus() {
  const { apiFetch } = useApi()
  const { isAuthenticated } = useAuth()

  const status = useState<GlobalStatus>('global_connection_status', () => 'offline')
  const providerName = useState<string | null>('global_provider_name', () => null)
  const operatingMode = useState<OperatingMode>('global_operating_mode', () => 'normal')
  const fallbackProviderName = useState<string | null>('global_fallback_provider_name', () => null)

  let timer: ReturnType<typeof setInterval> | null = null
  let polling = false

  async function poll() {
    if (!isAuthenticated.value) {
      status.value = 'offline'
      providerName.value = null
      operatingMode.value = 'normal'
      fallbackProviderName.value = null
      return
    }

    try {
      const data = await apiFetch<HealthSnapshot>('/api/health')

      operatingMode.value = data.operatingMode ?? 'normal'
      fallbackProviderName.value = data.fallbackProvider?.name ?? null

      if (!data.provider) {
        // Backend reachable but no provider configured
        status.value = 'healthy'
        providerName.value = null
      } else {
        providerName.value = data.provider.name
        switch (data.provider.status) {
          case 'healthy':
            status.value = 'healthy'
            break
          case 'degraded':
            status.value = 'degraded'
            break
          case 'down':
          case 'unconfigured':
          default:
            status.value = 'degraded'
            break
        }
      }
    } catch {
      status.value = 'offline'
      providerName.value = null
      operatingMode.value = 'normal'
      fallbackProviderName.value = null
    }
  }

  function start() {
    if (polling) return
    polling = true
    poll()
    timer = setInterval(poll, POLL_INTERVAL_MS)
  }

  function stop() {
    polling = false
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  return {
    status: readonly(status),
    providerName: readonly(providerName),
    operatingMode: readonly(operatingMode),
    fallbackProviderName: readonly(fallbackProviderName),
    start,
    stop,
    poll,
  }
}
