import { normalizeAppLogo, type AppLogo } from '@axiom/core/contracts'
import { useSettingsApi } from '~/api/settings'
import { resolveAppLogoAsset } from '~/utils/appLogo'

const STORAGE_KEY = 'axiom-app-logo'

/**
 * Instance-wide logo selected in Settings → Appearance. The last known value
 * is cached in localStorage so a reload does not flash the default logo
 * before the backend answers.
 */
export function useAppLogo() {
  const logo = useState<AppLogo>('app-logo', () =>
    normalizeAppLogo(import.meta.client ? localStorage.getItem(STORAGE_KEY) : null),
  )
  const asset = computed(() => resolveAppLogoAsset(logo.value))

  function setAppLogo(value: unknown) {
    logo.value = normalizeAppLogo(value)
    if (import.meta.client) localStorage.setItem(STORAGE_KEY, logo.value)
  }

  async function loadAppLogo() {
    const settingsApi = useSettingsApi()
    try {
      const appearance = await settingsApi.getAppearance()
      setAppLogo(appearance.logo)
    } catch (err) {
      console.warn('[axiom] Failed to load the app logo, keeping the cached one:', err)
    }
  }

  return {
    asset,
    setAppLogo,
    loadAppLogo,
  }
}
