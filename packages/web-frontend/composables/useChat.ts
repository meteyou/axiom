export interface ToolCallData {
  toolName: string
  toolCallId: string
  toolArgs?: unknown
  toolResult?: unknown
  toolIsError?: boolean
}

export interface ChatMessage {
  id?: number
  role: 'user' | 'assistant' | 'system' | 'tool' | 'divider'
  content: string
  timestamp?: string
  streaming?: boolean
  /** The source channel (for cross-channel messages) */
  source?: 'web' | 'telegram'
  /** Sender display name (for cross-channel messages) */
  senderName?: string
  /** Tool call details (for role=tool) */
  toolData?: ToolCallData
}

interface WsMessage {
  type: 'text' | 'tool_call_start' | 'tool_call_end' | 'error' | 'done' | 'system' | 'external_user_message' | 'session_end' | 'reminder'
  text?: string
  toolName?: string
  toolCallId?: string
  toolArgs?: unknown
  toolResult?: unknown
  toolIsError?: boolean
  error?: string
  sessionId?: string
  /** The source channel */
  source?: string
  /** Sender display name */
  senderName?: string
  /** Reminder message */
  reminderMessage?: string
  /** Reminder name */
  reminderName?: string
  /** Cronjob ID */
  cronjobId?: string
}

type ConnectionStatus = 'connecting' | 'connected' | 'disconnected'

function normalizeReminderText(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/^⏰\s*/u, '')
    .replace(/^(reminder|erinnerung)\s*:\s*/u, '')
    .replace(/[.!?]+$/u, '')
    .replace(/\s+/g, ' ')
}

function formatReminderContent(name?: string, message?: string): string {
  const trimmedName = name?.trim() ?? ''
  const trimmedMessage = message?.trim() ?? ''

  if (!trimmedName) return trimmedMessage ? `⏰ ${trimmedMessage}` : '⏰'
  if (!trimmedMessage) return `⏰ ${trimmedName}`

  const normalizedName = normalizeReminderText(trimmedName)
  const normalizedMessage = normalizeReminderText(trimmedMessage)

  if (
    normalizedName === normalizedMessage
    || normalizedMessage.includes(normalizedName)
    || normalizedName.includes(normalizedMessage)
  ) {
    return `⏰ ${trimmedMessage}`
  }

  return `⏰ ${trimmedName}\n\n${trimmedMessage}`
}

// Module-level singletons so multiple useChat() calls share the same WebSocket
let ws: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
/** Set to true during intentional disconnect (navigation away) to suppress auto-reconnect */
let intentionalDisconnect = false

export function useChat() {
  const messages = useState<ChatMessage[]>('chat_messages', () => [])
  const connectionStatus = useState<ConnectionStatus>('chat_status', () => 'disconnected')
  const sessionId = useState<string | null>('chat_session_id', () => null)
  const isStreaming = useState<boolean>('chat_streaming', () => false)

  function connect() {
    const { getAccessToken } = useAuth()
    const config = useRuntimeConfig()
    const token = getAccessToken()

    if (!token) return

    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return
    }

    connectionStatus.value = 'connecting'

    // Determine WebSocket URL from API base
    const apiBase = config.public.apiBase as string
    const wsBase = apiBase.replace(/^http/, 'ws')
    ws = new WebSocket(`${wsBase}/ws/chat?token=${encodeURIComponent(token)}`)

    ws.onopen = () => {
      connectionStatus.value = 'connected'
    }

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as WsMessage
        handleWsMessage(msg)
      } catch {
        // ignore parse errors
      }
    }

    ws.onclose = () => {
      connectionStatus.value = 'disconnected'
      ws = null
      // Only auto-reconnect if this was NOT an intentional disconnect
      // (e.g. navigating away from the chat page)
      if (!intentionalDisconnect) {
        reconnectTimer = setTimeout(() => {
          const { isAuthenticated } = useAuth()
          if (isAuthenticated.value) {
            connect()
          }
        }, 3000)
      }
      intentionalDisconnect = false
    }

    ws.onerror = () => {
      // onclose will fire after onerror
    }
  }

  function handleWsMessage(msg: WsMessage) {
    switch (msg.type) {
      case 'system':
        if (msg.sessionId) {
          sessionId.value = msg.sessionId
        }
        if (msg.text && msg.text !== 'Authenticated') {
          // Show system messages (like session reset)
          messages.value = [...messages.value, {
            role: 'system',
            content: msg.text,
            timestamp: new Date().toISOString(),
          }]
        }
        isStreaming.value = false
        break

      case 'session_end':
        if (msg.sessionId) {
          sessionId.value = msg.sessionId
        }
        // Add a divider with optional summary to the chat
        messages.value = [...messages.value, {
          role: 'divider',
          content: msg.text ?? '',
          timestamp: new Date().toISOString(),
        }]
        isStreaming.value = false
        break

      case 'external_user_message':
        // A message from another channel (e.g. Telegram) for the same user
        if (msg.text) {
          messages.value = [...messages.value, {
            role: 'user',
            content: msg.text,
            timestamp: new Date().toISOString(),
            source: (msg.source as 'web' | 'telegram') ?? undefined,
            senderName: msg.senderName,
          }]
        }
        break

      case 'reminder': {
        const reminderContent = formatReminderContent(msg.reminderName, msg.reminderMessage)

        if (reminderContent) {
          messages.value = [...messages.value, {
            role: 'system',
            content: reminderContent,
            timestamp: new Date().toISOString(),
          }]

          if (
            typeof window !== 'undefined'
            && typeof Notification !== 'undefined'
            && document.visibilityState !== 'visible'
            && Notification.permission === 'granted'
          ) {
            new Notification(msg.reminderName || 'Reminder', {
              body: msg.reminderMessage,
            })
          }
        }
        break
      }

      case 'text':
        if (msg.text) {
          const lastMsg = messages.value[messages.value.length - 1]
          if (lastMsg && lastMsg.role === 'assistant' && lastMsg.streaming) {
            // Append to existing streaming message
            const updated = [...messages.value]
            updated[updated.length - 1] = {
              ...lastMsg,
              content: lastMsg.content + msg.text,
            }
            messages.value = updated
          } else {
            // Start new assistant message
            messages.value = [...messages.value, {
              role: 'assistant',
              content: msg.text,
              timestamp: new Date().toISOString(),
              streaming: true,
            }]
          }
          isStreaming.value = true
        }
        break

      case 'done':
        // Mark last message as done streaming
        if (messages.value.length > 0) {
          const updated = [...messages.value]
          const last = updated[updated.length - 1]
          if (last && last.streaming) {
            updated[updated.length - 1] = { ...last, streaming: false }
            messages.value = updated
          }
        }
        isStreaming.value = false
        break

      case 'error':
        messages.value = [...messages.value, {
          role: 'system',
          content: `Error: ${msg.error}`,
          timestamp: new Date().toISOString(),
        }]
        isStreaming.value = false
        break

      case 'tool_call_start':
        if (msg.toolName) {
          messages.value = [...messages.value, {
            role: 'tool',
            content: `Tool: ${msg.toolName}`,
            timestamp: new Date().toISOString(),
            toolData: {
              toolName: msg.toolName,
              toolCallId: msg.toolCallId ?? '',
              toolArgs: msg.toolArgs,
            },
          }]
        }
        break

      case 'tool_call_end':
        if (msg.toolCallId) {
          const updated = [...messages.value]
          const toolMsgIdx = updated.findLastIndex(
            m => m.role === 'tool' && m.toolData?.toolCallId === msg.toolCallId
          )
          if (toolMsgIdx !== -1) {
            updated[toolMsgIdx] = {
              ...updated[toolMsgIdx],
              toolData: {
                ...updated[toolMsgIdx].toolData!,
                toolResult: msg.toolResult,
                toolIsError: msg.toolIsError,
              },
            }
            messages.value = updated
          }
        }
        break
    }
  }

  function sendMessage(content: string) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    if (!content.trim()) return

    // Add user message to UI immediately
    messages.value = [...messages.value, {
      role: 'user',
      content: content.trim(),
      timestamp: new Date().toISOString(),
    }]

    ws.send(JSON.stringify({ type: 'message', content: content.trim() }))
  }

  function sendCommand(command: string) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ type: 'command', content: `/${command}` }))
  }

  function newSession() {
    sendCommand('new')
  }

  function stopTask() {
    sendCommand('stop')
  }

  function disconnect() {
    intentionalDisconnect = true
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    if (ws) {
      ws.close()
      ws = null
    }
    connectionStatus.value = 'disconnected'
  }

  function clearMessages() {
    messages.value = []
  }

  return {
    messages,
    connectionStatus,
    sessionId,
    isStreaming,
    connect,
    disconnect,
    sendMessage,
    newSession,
    stopTask,
    clearMessages,
  }
}
