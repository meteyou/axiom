export interface ToolCallData {
  toolName: string
  toolCallId: string
  toolArgs?: unknown
  toolResult?: unknown
  toolIsError?: boolean
}

export interface ChatAttachment {
  kind: 'image' | 'file'
  originalName: string
  storedName: string
  relativePath: string
  urlPath: string
  mimeType: string
  size: number
  previewUrl?: string
  width?: number
  height?: number
}

export interface ChatMessage {
  id?: number
  role: 'user' | 'assistant' | 'system' | 'tool' | 'divider'
  content: string
  timestamp?: string
  streaming?: boolean
  attachments?: ChatAttachment[]
  /** The source channel (for cross-channel messages) */
  source?: 'web' | 'telegram'
  /** Sender display name (for cross-channel messages) */
  senderName?: string
  /** Tool call details (for role=tool) */
  toolData?: ToolCallData
  /** Whether this message was also delivered to Telegram */
  telegramDelivered?: boolean
  /** Whether this is a task injection response */
  isTaskInjection?: boolean
  /** Whether this is a task result notification (system message) */
  isTaskResult?: boolean
  /** Task result display name */
  taskResultName?: string
  /** Task result status: completed, failed, question */
  taskResultStatus?: string
  /** Task duration in minutes */
  taskResultDuration?: number
}

interface WsMessage {
  type: 'text' | 'tool_call_start' | 'tool_call_end' | 'error' | 'done' | 'system' | 'external_user_message' | 'session_end' | 'reminder' | 'task_completed' | 'task_failed' | 'task_question'
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
  /** Whether this message was also delivered to Telegram */
  telegramDelivered?: boolean
  /** Whether this is a task injection response */
  isTaskInjection?: boolean
  /** Task name (for task_completed/task_failed/task_question) */
  taskName?: string
  /** Task summary */
  taskSummary?: string
  /** Task ID */
  taskId?: string
  /** Task duration in minutes */
  taskDurationMinutes?: number
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

function parseAttachments(metadata?: string): ChatAttachment[] {
  if (!metadata) return []
  try {
    const parsed = JSON.parse(metadata) as { files?: ChatAttachment[] }
    return Array.isArray(parsed.files) ? parsed.files : []
  } catch {
    return []
  }
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

      // Clean up stale streaming messages from before the reconnect.
      // If we lost the connection mid-stream, those messages will never
      // receive a 'done' event, so force them to non-streaming.
      const staleFixed = messages.value.map(m =>
        m.streaming ? { ...m, streaming: false } : m
      )
      if (staleFixed.some((m, i) => m !== messages.value[i])) {
        messages.value = staleFixed
      }
      isStreaming.value = false
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

      case 'task_completed':
      case 'task_failed':
      case 'task_question': {
        const emoji = msg.type === 'task_completed' ? '✅' : msg.type === 'task_failed' ? '❌' : '❓'
        const statusLabel = msg.type.replace('task_', '')
        const content = `${emoji} Task ${statusLabel}: ${msg.taskName ?? 'Unknown'}\n\n${msg.taskSummary ?? msg.text ?? 'No summary available.'}`
        messages.value = [...messages.value, {
          role: 'system',
          content,
          timestamp: new Date().toISOString(),
          isTaskResult: true,
          taskResultName: msg.taskName ?? 'Background Task',
          taskResultStatus: statusLabel,
          taskResultDuration: msg.taskDurationMinutes,
        }]
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
              isTaskInjection: lastMsg.isTaskInjection || msg.isTaskInjection,
            }
            messages.value = updated
          } else {
            // Start new assistant message
            messages.value = [...messages.value, {
              role: 'assistant',
              content: msg.text,
              timestamp: new Date().toISOString(),
              streaming: true,
              isTaskInjection: msg.isTaskInjection,
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
            updated[updated.length - 1] = {
              ...last,
              streaming: false,
              telegramDelivered: msg.telegramDelivered || last.telegramDelivered,
              isTaskInjection: msg.isTaskInjection || last.isTaskInjection,
            }
            messages.value = updated
          }
        }
        isStreaming.value = false
        break

      case 'error': {
        // Clear streaming flag on the last message so it doesn't stay
        // stuck with a loading indicator forever
        const updatedOnError = [...messages.value]
        const lastOnError = updatedOnError[updatedOnError.length - 1]
        if (lastOnError && lastOnError.streaming) {
          updatedOnError[updatedOnError.length - 1] = { ...lastOnError, streaming: false }
        }
        updatedOnError.push({
          role: 'system',
          content: `Error: ${msg.error}`,
          timestamp: new Date().toISOString(),
        })
        messages.value = updatedOnError
        isStreaming.value = false
        break
      }

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

  async function sendMessage(content: string, files: File[] = []) {
    const trimmed = content.trim()
    if (!trimmed && files.length === 0) return

    if (files.length > 0) {
      const { apiFetch } = useApi()
      const formData = new FormData()
      formData.append('content', trimmed)
      for (const file of files) formData.append('files', file)

      const response = await apiFetch<{ message: { session_id: string; role: 'user'; content: string; metadata?: string; timestamp: string } }>('/api/chat/message', {
        method: 'POST',
        body: formData as unknown as BodyInit,
      })

      const attachments = parseAttachments(response.message.metadata)
      messages.value = [...messages.value, {
        role: 'user',
        content: response.message.content,
        timestamp: response.message.timestamp,
        attachments,
      }]

      // Trigger the agent via WebSocket (message already saved by HTTP route)
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'message', content: response.message.content, skipSave: true, attachments }))
      }
      return
    }

    if (!ws || ws.readyState !== WebSocket.OPEN) return
    if (!trimmed) return

    messages.value = [...messages.value, {
      role: 'user',
      content: trimmed,
      timestamp: new Date().toISOString(),
    }]

    ws.send(JSON.stringify({ type: 'message', content: trimmed }))
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
