export interface ChatMessage {
  id?: number
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp?: string
  streaming?: boolean
}

interface WsMessage {
  type: 'text' | 'tool_call_start' | 'tool_call_end' | 'error' | 'done' | 'system'
  text?: string
  toolName?: string
  toolCallId?: string
  toolArgs?: unknown
  toolResult?: unknown
  toolIsError?: boolean
  error?: string
  sessionId?: string
}

type ConnectionStatus = 'connecting' | 'connected' | 'disconnected'

export function useChat() {
  const messages = useState<ChatMessage[]>('chat_messages', () => [])
  const connectionStatus = useState<ConnectionStatus>('chat_status', () => 'disconnected')
  const sessionId = useState<string | null>('chat_session_id', () => null)
  const isStreaming = useState<boolean>('chat_streaming', () => false)

  let ws: WebSocket | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null

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
      // Auto-reconnect after 3 seconds
      reconnectTimer = setTimeout(() => {
        const { isAuthenticated } = useAuth()
        if (isAuthenticated.value) {
          connect()
        }
      }, 3000)
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
            role: 'system',
            content: `Calling tool: ${msg.toolName}`,
            timestamp: new Date().toISOString(),
          }]
        }
        break

      case 'tool_call_end':
        // Tool result — could enhance display later
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
    messages.value = []
  }

  function stopTask() {
    sendCommand('stop')
  }

  function disconnect() {
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
