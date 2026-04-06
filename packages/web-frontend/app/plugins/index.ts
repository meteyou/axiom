import { registerPlugin, setPluginEnabled } from '~/utils/pluginRegistry'
import voiceInputPlugin from './voice-input/index'

/**
 * Nuxt plugin: registers all frontend plugins at app startup.
 * Reads persisted enabled/disabled state from localStorage before registering.
 */
export default defineNuxtPlugin(() => {
  // List of all plugins to register
  const allPlugins = [voiceInputPlugin]

  for (const plugin of allPlugins) {
    // Register the plugin (components stored, default enabled = true)
    registerPlugin(plugin)

    // Read persisted enabled state from localStorage (client-side only)
    if (import.meta.client) {
      const stored = localStorage.getItem(`plugin:${plugin.id}`)
      if (stored !== null) {
        try {
          const enabled = JSON.parse(stored) as boolean
          setPluginEnabled(plugin.id, enabled)
        } catch {
          // Ignore malformed stored values
        }
      }
    }
  }
})
