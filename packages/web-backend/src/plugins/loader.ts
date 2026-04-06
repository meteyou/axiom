import type { Express } from 'express'
import type { OpenAgentPlugin } from './types.js'

// Static plugin registry — import each plugin explicitly.
// This avoids dynamic filesystem scanning which is fragile in bundled/dist builds.
import voiceInputPlugin from './voice-input/index.js'

const plugins: OpenAgentPlugin[] = [
  voiceInputPlugin,
]

/**
 * Registers all plugins with the Express app.
 * Errors in individual plugins are caught so they cannot crash the server.
 */
export async function loadPlugins(app: Express): Promise<void> {
  for (const plugin of plugins) {
    try {
      await plugin.register(app)
      console.log(`[plugins] Loaded plugin: ${plugin.name}@${plugin.version}`)
    } catch (err) {
      console.error(`[plugins] Failed to load plugin "${plugin.name}":`, err)
    }
  }
}
