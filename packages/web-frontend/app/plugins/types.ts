import type { Component } from 'vue'

export interface OpenAgentFrontendPlugin {
  name: string
  slots: Partial<{
    /** Components rendered next to the send button in the chat input area */
    'chat-input-actions': Component
  }>
}
