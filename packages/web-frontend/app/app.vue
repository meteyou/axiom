<template>
  <TooltipProvider>
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </TooltipProvider>
</template>

<script setup lang="ts">
import { initPlugins } from '~/plugins/index'

// Initialize color mode on mount — ensures .dark / .light class is applied
// before first paint based on localStorage preference or system preference.
const { mode } = useTheme()

// Initialize frontend plugins
initPlugins()

// Apply class on the HTML element immediately (SSR-safe no-op since ssr: false)
if (import.meta.client) {
  const stored = localStorage.getItem('openagent-color-mode')
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  const resolved = stored === 'light' ? 'light' : stored === 'dark' ? 'dark' : (prefersDark ? 'dark' : 'light')
  document.documentElement.classList.toggle('dark', resolved === 'dark')
  document.documentElement.classList.toggle('light', resolved === 'light')
}
</script>
