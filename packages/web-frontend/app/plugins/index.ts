import { registerPlugin } from './registry'
import voiceInputPlugin from './voice-input/index'

/**
 * Register all frontend plugins.
 * Called once during app initialization.
 */
export function initPlugins(): void {
  registerPlugin(voiceInputPlugin)
}

// Nuxt requires a default export for files in the plugins/ directory
export default defineNuxtPlugin(() => {
  initPlugins()
})
