import type { OpenAgentPlugin } from '../types.js'
import { createVoiceRouter } from './routes.js'

export default {
  name: 'voice-input',
  version: '1.0.0',
  register(app) {
    app.use('/api/plugins/voice', createVoiceRouter())
  },
} satisfies OpenAgentPlugin
