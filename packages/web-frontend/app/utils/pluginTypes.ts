import type { Component } from 'vue'

export interface OpenAgentFrontendPlugin {
  /** Unique identifier for the plugin (used for enable/disable state) */
  id: string
  name: string
  slots: Partial<{
    /** Components rendered next to the send button in the chat input area */
    'chat-input-actions': Component
  }>
}
