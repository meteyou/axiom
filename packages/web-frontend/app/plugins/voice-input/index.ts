import type { OpenAgentFrontendPlugin } from '../types'
import VoiceInput from './VoiceInput.vue'

export default {
  name: 'voice-input',
  slots: {
    'chat-input-actions': VoiceInput,
  },
} satisfies OpenAgentFrontendPlugin
