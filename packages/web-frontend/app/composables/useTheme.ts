import { useColorMode, usePreferredDark } from '@vueuse/core'

export type ColorMode = 'dark' | 'light' | 'auto'

/**
 * Composable for managing dark/light/system theme with persistence.
 * Uses @vueuse/core useColorMode which:
 *   - Persists the choice to localStorage
 *   - Adds/removes `.dark` class on <html>
 *   - Falls back to system preference when mode is 'auto'
 */
export function useTheme() {
  const mode = useColorMode({
    attribute: 'class',
    modes: {
      dark: 'dark',
      light: 'light',
    },
    storageKey: 'axiom-color-mode',
    // Default to system preference
    initialValue: 'auto',
  })

  const prefersDark = usePreferredDark()

  /** The resolved mode (never 'auto') */
  const resolvedMode = computed<'dark' | 'light'>(() => {
    if (mode.value === 'auto') {
      return prefersDark.value ? 'dark' : 'light'
    }
    return mode.value as 'dark' | 'light'
  })

  const isDark = computed(() => resolvedMode.value === 'dark')

  function setMode(newMode: ColorMode) {
    mode.value = newMode as typeof mode.value
  }

  function toggle() {
    mode.value = isDark.value ? 'light' : 'dark'
  }

  return {
    /** Current stored preference: 'dark' | 'light' | 'auto' */
    mode,
    /** Resolved effective mode (system preference resolved) */
    resolvedMode,
    /** Whether dark mode is currently active */
    isDark,
    /** Set the color mode preference */
    setMode,
    /** Toggle between dark and light */
    toggle,
  }
}
