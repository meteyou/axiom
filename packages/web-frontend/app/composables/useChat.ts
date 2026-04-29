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
  /**
   * Whether this is a periodic task-status heartbeat (system message).
   * Rendered as a compact single-line progress row so it does not look
   * like a completed-task card.
   */
  isTaskStatusUpdate?: boolean
  /** Task name for the heartbeat */
  taskStatusUpdateName?: string
  /** How long the task has been running so far, in minutes */
  taskStatusRuntimeMinutes?: number
  /** Number of tool calls the task has made so far */
  taskStatusToolCallCount?: number
  /** Approximate total tokens the task has consumed so far */
  taskStatusTokensUsed?: number
  /**
   * Whether this assistant message is a thinking/reasoning block.
   * Rendered as a separate collapsible card (sparkles icon).
   */
  isThinking?: boolean
  /**
   * Excerpt of the message the user replied to (e.g. Telegram reply-to), truncated to 500 chars.
   * When present, the UI renders a WhatsApp/Telegram-style quote bubble above the
   * message body with `[Replying to: "…"]`. Only set for `role: 'user'`.
   */
  replyContext?: string
}

interface WsMessage {
  type: 'text' | 'thinking' | 'tool_call_start' | 'tool_call_end' | 'error' | 'done' | 'system' | 'external_user_message' | 'session_end' | 'reminder' | 'task_completed' | 'task_failed' | 'task_question' | 'task_status_update' | 'pong' | 'attachment'
  text?: string
  /** Uploaded file the agent sent for the current turn (for type='attachment') */
  attachment?: ChatAttachment
  /** Thinking delta (for type='thinking') */
  thinking?: string
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
  /** Excerpt of the message the user replied to (for type='external_user_message') */
  replyContext?: string
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
  /** Human-readable content for task_status_update events */
  taskStatusContent?: string
  /** Task runtime in minutes (task_status_update) */
  taskStatusRuntimeMinutes?: number
  /** Task tool-call count so far (task_status_update) */
  taskStatusToolCallCount?: number
  /** Task tokens consumed so far (task_status_update) */
  taskStatusTokensUsed?: number
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

/**
 * If the last message is a streaming thinking block, mark it as done.
 * Used when a non-thinking chunk (text / tool / done) arrives so the
 * thinking card stops showing the typing indicator.
 */
function closeStreamingThinking(list: ChatMessage[]): ChatMessage[] {
  if (list.length === 0) return list
  const last = list[list.length - 1]!
  if (last.role === 'assistant' && last.isThinking && last.streaming) {
    const updated = [...list]
    updated[updated.length - 1] = { ...last, streaming: false }
    return updated
  }
  return list
}

function insertBeforeTrailingStreams(list: ChatMessage[], message: ChatMessage): ChatMessage[] {
  let insertAt = list.length
  while (insertAt > 0 && list[insertAt - 1]?.streaming) {
    insertAt--
  }
  return [...list.slice(0, insertAt), message, ...list.slice(insertAt)]
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
let heartbeatInterval: ReturnType<typeof setInterval> | null = null
let pongTimeout: ReturnType<typeof setTimeout> | null = null
/** Current reconnect delay in ms — doubles on each failed attempt (max 30 s) */
let reconnectDelay = 2000
/** Set to true during intentional disconnect (navigation away) to suppress auto-reconnect */
let intentionalDisconnect = false
/** Ensure the global online/visibilitychange listeners are registered only once */
let globalListenersRegistered = false

function stopHeartbeat() {
  if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null }
  if (pongTimeout) { clearTimeout(pongTimeout); pongTimeout = null }
}

function startHeartbeat(wsRef: () => WebSocket | null) {
  stopHeartbeat()
  heartbeatInterval = setInterval(() => {
    const socket = wsRef()
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    socket.send(JSON.stringify({ type: 'ping' }))
    // If no pong arrives within 10 s the connection is silently dead — force close
    pongTimeout = setTimeout(() => { wsRef()?.close() }, 10_000)
  }, 10_000)
}

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

    // Register global event listeners once so we reconnect on network recovery
    // or when the browser tab becomes visible again after a long sleep.
    if (!globalListenersRegistered && typeof window !== 'undefined') {
      globalListenersRegistered = true

      window.addEventListener('online', () => {
        if (intentionalDisconnect) return
        if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
          reconnectDelay = 2000 // reset backoff on explicit network recovery
          connect()
        }
      })

      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible' || intentionalDisconnect) return
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          connect()
        }
      })
    }

    // Determine WebSocket URL from API base
    const apiBase = config.public.apiBase as string
    const wsBase = apiBase.replace(/^http/, 'ws')
    ws = new WebSocket(`${wsBase}/ws/chat?token=${encodeURIComponent(token)}`)

    ws.onopen = () => {
      reconnectDelay = 2000 // reset exponential backoff after successful connect
      connectionStatus.value = 'connected'
      startHeartbeat(() => ws)

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
      stopHeartbeat()
      connectionStatus.value = 'disconnected'
      ws = null
      // Only auto-reconnect if this was NOT an intentional disconnect
      // (e.g. navigating away from the chat page)
      if (!intentionalDisconnect) {
        reconnectTimer = setTimeout(() => connect(), reconnectDelay)
        // Exponential backoff: 2 s → 4 s → 8 s → … capped at 30 s
        reconnectDelay = Math.min(reconnectDelay * 2, 30_000)
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
            replyContext: msg.replyContext,
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

      case 'task_status_update': {
        // Ephemeral heartbeat from a running background task. Rendered as a
        // compact single-line progress row; distinct from task_result cards
        // because the task is still in progress.
        const taskName = msg.taskName ?? 'Background Task'
        const content = msg.taskStatusContent ?? `⏱ Task running: ${taskName}`
        messages.value = insertBeforeTrailingStreams(messages.value, {
          role: 'system',
          content,
          timestamp: new Date().toISOString(),
          isTaskStatusUpdate: true,
          taskStatusUpdateName: taskName,
          taskStatusRuntimeMinutes: msg.taskStatusRuntimeMinutes,
          taskStatusToolCallCount: msg.taskStatusToolCallCount,
          taskStatusTokensUsed: msg.taskStatusTokensUsed,
        })
        break
      }

      case 'text':
        if (msg.text) {
          const lastMsg = messages.value[messages.value.length - 1]
          if (lastMsg && lastMsg.role === 'assistant' && !lastMsg.isThinking && lastMsg.streaming) {
            // Append to existing streaming message (but not to a thinking block)
            const updated = [...messages.value]
            updated[updated.length - 1] = {
              ...lastMsg,
              content: lastMsg.content + msg.text,
              isTaskInjection: lastMsg.isTaskInjection || msg.isTaskInjection,
            }
            messages.value = updated
          } else {
            // Close any streaming thinking block and start new assistant message
            const closed = closeStreamingThinking(messages.value)
            messages.value = [...closed, {
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

      case 'thinking':
        if (msg.thinking) {
          const lastMsg = messages.value[messages.value.length - 1]
          if (lastMsg && lastMsg.role === 'assistant' && lastMsg.isThinking && lastMsg.streaming) {
            // Append to existing streaming thinking block
            const updated = [...messages.value]
            updated[updated.length - 1] = {
              ...lastMsg,
              content: lastMsg.content + msg.thinking,
            }
            messages.value = updated
          } else {
            // Start a new streaming thinking block (close any open non-thinking stream)
            messages.value = [...messages.value, {
              role: 'assistant',
              content: msg.thinking,
              timestamp: new Date().toISOString(),
              streaming: true,
              isThinking: true,
            }]
          }
          isStreaming.value = true
        }
        break

      case 'done':
        // Mark all trailing streaming messages (text + thinking) as done.
        // A turn can end with a thinking block still streaming if the model
        // emitted thinking without follow-up text (rare but possible).
        if (messages.value.length > 0) {
          const updated = [...messages.value]
          for (let i = updated.length - 1; i >= 0; i--) {
            const m = updated[i]!
            if (!m.streaming) break
            updated[i] = {
              ...m,
              streaming: false,
              telegramDelivered: m.isThinking ? m.telegramDelivered : (msg.telegramDelivered || m.telegramDelivered),
              isTaskInjection: m.isThinking ? m.isTaskInjection : (msg.isTaskInjection || m.isTaskInjection),
            }
          }
          messages.value = updated
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
          // A tool call also ends any in-flight thinking block.
          const closed = closeStreamingThinking(messages.value)
          messages.value = [...closed, {
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

      case 'pong':
        // Clear the pong-timeout so the heartbeat knows the connection is alive
        if (pongTimeout) { clearTimeout(pongTimeout); pongTimeout = null }
        break

      case 'attachment':
        // A file sent by the agent for the current assistant turn (e.g. via
        // the `send_file_to_user` tool). We attach it to the in-progress
        // assistant message so the download card renders inside the bubble
        // — same visual treatment as user-side attachments, just on the
        // opposite side.
        //
        // If no assistant message is currently streaming (rare: the tool
        // fired mid-thinking, or the model hasn't emitted text yet) we
        // synthesize a minimal assistant bubble so the attachment still
        // appears in the flow.
        if (msg.attachment) {
          const attachment = msg.attachment
          const updated = [...messages.value]
          const lastIdx = updated.length - 1
          const last = lastIdx >= 0 ? updated[lastIdx]! : null
          if (last && last.role === 'assistant' && !last.isThinking) {
            const existing = last.attachments ?? []
            // Guard against duplicates (e.g. if the same upload is
            // broadcast twice by ws-chat + chatEventBus echo).
            if (!existing.some(a => a.relativePath === attachment.relativePath)) {
              updated[lastIdx] = { ...last, attachments: [...existing, attachment] }
              messages.value = updated
            }
          } else {
            // Close any open thinking block before inserting the new bubble.
            const closed = closeStreamingThinking(messages.value)
            messages.value = [...closed, {
              role: 'assistant',
              content: '',
              timestamp: new Date().toISOString(),
              streaming: true,
              attachments: [attachment],
            }]
          }
        }
        break

      case 'tool_call_end':
        if (msg.toolCallId) {
          const updated = [...messages.value]
          const toolMsgIdx = updated.findLastIndex(
            m => m.role === 'tool' && m.toolData?.toolCallId === msg.toolCallId
          )
          const existingMsg = toolMsgIdx !== -1 ? updated[toolMsgIdx] : undefined
          if (existingMsg) {
            updated[toolMsgIdx] = {
              ...existingMsg,
              toolData: {
                ...existingMsg.toolData!,
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
    stopHeartbeat()
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
