import type { OpenAgentFrontendPlugin } from '~/utils/pluginTypes'
import VoiceInput from './VoiceInput.vue'

const voiceInputPlugin: OpenAgentFrontendPlugin = {
  id: 'voice-input',
  name: 'voice-input',
  slots: {
    'chat-input-actions': VoiceInput,
  },
}

export default voiceInputPlugin
