<template>
  <div class="relative flex h-full flex-col overflow-hidden">
    <!-- Chat toolbar -->
    <div class="flex shrink-0 items-center gap-2 border-b border-border bg-background px-6 py-2">
      <!-- Chat connection status -->
      <div class="flex items-center gap-2 text-sm text-muted-foreground">
        <span
          class="h-2 w-2 shrink-0 rounded-full"
          :class="{
            'bg-success shadow-[0_0_6px_hsl(var(--success))]': connectionStatus === 'connected',
            'bg-warning animate-pulse': connectionStatus === 'connecting',
            'bg-muted-foreground': connectionStatus === 'disconnected',
          }"
        />
        <span class="hidden sm:inline">{{ chatStatusText }}</span>
      </div>

      <div class="flex-1" />

      <Button
        variant="outline"
        size="sm"
        class="gap-2 hover:border-destructive hover:text-destructive"
        :disabled="!isStreaming"
        @click="handleStop"
      >
        <AppIcon name="square" class="h-4 w-4" />
        <span class="hidden sm:inline">{{ $t('chat.stop') }}</span>
      </Button>
      <Button variant="outline" size="sm" class="gap-2" @click="handleNewSession">
        <AppIcon name="sparkles" class="h-4 w-4" />
        <span class="hidden sm:inline">{{ $t('chat.newSession') }}</span>
      </Button>
    </div>

    <!-- Messages area -->
    <div ref="messagesContainer" class="relative flex flex-1 flex-col gap-4 overflow-y-auto p-4" @scroll="onMessagesScroll" @copy="handleCopyAsMarkdown">
      <!-- Loading history -->
      <template v-if="loadingHistory">
        <div class="flex flex-col gap-3">
          <!-- assistant skeleton -->
          <div class="flex items-start gap-3 self-start">
            <Skeleton class="h-8 w-8 shrink-0 rounded-full" />
            <div class="space-y-2">
              <Skeleton class="h-4 w-48 rounded-xl" />
              <Skeleton class="h-4 w-64 rounded-xl" />
            </div>
          </div>
          <!-- user skeleton -->
          <div class="flex flex-row-reverse items-start gap-3 self-end">
            <Skeleton class="h-8 w-8 shrink-0 rounded-full" />
            <Skeleton class="h-4 w-36 rounded-xl" />
          </div>
          <!-- assistant skeleton -->
          <div class="flex items-start gap-3 self-start">
            <Skeleton class="h-8 w-8 shrink-0 rounded-full" />
            <div class="space-y-2">
              <Skeleton class="h-4 w-56 rounded-xl" />
              <Skeleton class="h-4 w-40 rounded-xl" />
              <Skeleton class="h-4 w-52 rounded-xl" />
            </div>
          </div>
        </div>
      </template>

      <!-- Empty state -->
      <div
        v-else-if="messages.length === 0"
        class="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground"
      >
        <AppIcon name="chat" class="h-10 w-10 opacity-40" />
        <p class="text-sm">{{ $t('chat.noMessages') }}</p>
      </div>

      <!-- Messages -->
      <template v-else>
        <div
          v-for="(msg, i) in messages"
          :key="i"
          :class="[
            msg.role === 'divider'
              ? 'w-full animate-in fade-in duration-200'
              : (msg.role === 'tool' || (msg.role === 'system' && msg.isTaskResult))
                ? 'self-start w-full max-w-[80%] sm:max-w-[75%] pl-11'
                : 'flex max-w-[80%] gap-3 sm:max-w-[75%]',
            (msg.role === 'tool' || msg.role === 'divider' || (msg.role === 'system' && msg.isTaskResult)) ? '' : 'animate-in fade-in slide-in-from-bottom-2 duration-200',
            {
              'self-end flex-row-reverse': msg.role === 'user',
              'self-start': msg.role === 'assistant',
              'self-center max-w-[90%] !sm:max-w-[85%]': msg.role === 'system' && !msg.isTaskResult,
            },
          ]"
        >
          <!-- Session divider -->
          <template v-if="msg.role === 'divider'">
            <div class="w-full max-w-none px-2">
              <p v-if="msg.content" class="mx-auto mb-2 max-w-md text-center text-xs leading-relaxed text-muted-foreground/70">
                {{ msg.content }}
              </p>
              <div class="relative flex items-center py-2">
                <div class="grow border-t border-border" />
                <div class="mx-4 flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                  <AppIcon name="sparkles" class="h-3 w-3" />
                  <span>{{ $t('chat.newSessionDivider') }}</span>
                </div>
                <div class="grow border-t border-border" />
              </div>
            </div>
          </template>

          <!-- Tool call card (clickable/expandable) -->
          <template v-else-if="msg.role === 'tool' && msg.toolData">
            <div class="w-full overflow-hidden rounded-lg border border-border">
              <!-- Header (clickable) -->
              <button
                class="group flex w-full items-center gap-2 bg-muted/30 px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/60"
                :class="{ 'border-b border-border': expandedTools.has(msg.toolData!.toolCallId) }"
                @click="toggleTool(msg.toolData!.toolCallId)"
              >
                <svg
                  class="h-3 w-3 shrink-0 transition-transform duration-200"
                  :class="{ 'rotate-90': expandedTools.has(msg.toolData!.toolCallId) }"
                  viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                >
                  <polyline points="9 18 15 12 9 6" />
                </svg>
                <AppIcon :name="isToolSkillLoad(msg.toolData!) ? 'puzzle' : 'settings'" class="h-3 w-3 shrink-0 opacity-60" />
                <span class="font-medium">{{ toolDisplayName(msg.toolData!) }}</span>
                <span
                  v-if="msg.toolData!.toolIsError"
                  class="ml-auto rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium text-destructive"
                >
                  Error
                </span>
                <span
                  v-else-if="msg.toolData!.toolResult !== undefined"
                  class="ml-auto rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400"
                >
                  Success
                </span>
                <span
                  v-else
                  class="ml-auto inline-flex items-center gap-1 text-[10px]"
                >
                  <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
                  Running
                </span>
              </button>
              <!-- Expanded details -->
              <div
                v-if="expandedTools.has(msg.toolData!.toolCallId)"
                class="bg-background text-xs"
              >
                <!-- Input (hidden for skill loads) -->
                <div v-if="!isToolSkillLoad(msg.toolData!)" class="border-b border-border px-3 py-2">
                  <p class="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Input</p>
                  <ToolDataDisplay :data="msg.toolData!.toolArgs" />
                </div>
                <!-- Output -->
                <div class="max-h-60 overflow-y-auto px-3 py-2">
                  <p class="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Output</p>
                  <template v-if="isToolSkillLoad(msg.toolData!)">
                    <pre class="whitespace-pre-wrap break-all text-xs text-foreground">{{ extractSkillContent(msg.toolData!.toolResult) ?? '' }}</pre>
                  </template>
                  <template v-else>
                    <ToolDataDisplay :data="msg.toolData!.toolResult" :is-error="msg.toolData!.toolIsError" />
                  </template>
                </div>
              </div>
            </div>
          </template>

          <!-- Task result notification (collapsible, same style as tool call) -->
          <template v-else-if="msg.role === 'system' && msg.isTaskResult">
            <div class="w-full overflow-hidden rounded-lg border border-border">
              <!-- Header (clickable) -->
              <button
                class="group flex w-full items-center gap-2 bg-muted/30 px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/60"
                :class="{ 'border-b border-border': expandedInjections.has(i) }"
                @click="toggleInjection(i)"
              >
                <svg
                  class="h-3 w-3 shrink-0 transition-transform duration-200"
                  :class="{ 'rotate-90': expandedInjections.has(i) }"
                  viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                >
                  <polyline points="9 18 15 12 9 6" />
                </svg>
                <AppIcon name="zap" class="h-3 w-3 shrink-0 opacity-60" />
                <span class="font-medium">{{ msg.taskResultName ?? 'Background Task' }}</span>
                <span
                  v-if="msg.taskResultDuration"
                  class="ml-1 text-[10px] text-muted-foreground/60"
                >
                  ({{ msg.taskResultDuration }}min)
                </span>
                <span
                  class="ml-auto rounded px-1.5 py-0.5 text-[10px] font-medium"
                  :class="msg.taskResultStatus === 'failed'
                    ? 'bg-destructive/10 text-destructive'
                    : msg.taskResultStatus === 'question'
                      ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
                      : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'"
                >
                  {{ msg.taskResultStatus === 'failed' ? 'Failed' : msg.taskResultStatus === 'question' ? 'Question' : 'Completed' }}
                </span>
              </button>
              <!-- Expanded details -->
              <div v-if="expandedInjections.has(i)" class="bg-background text-xs">
                <div class="max-h-60 overflow-y-auto px-3 py-2">
                  <div class="prose-chat break-words text-xs text-foreground" v-html="renderMarkdown(taskResultBody(msg.content))" />
                </div>
              </div>
            </div>
          </template>

          <!-- Regular messages (user / assistant / system) -->
          <template v-else>
            <!-- Avatar -->
            <div
              class="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-muted-foreground"
            >
              <!-- User avatar -->
              <template v-if="msg.role === 'user'">
                <img
                  v-if="userAvatarUrl && !avatarFailed"
                  :src="userAvatarUrl"
                  :alt="user?.username"
                  class="h-8 w-8 rounded-full object-cover"
                  @error="onAvatarError"
                >
                <span
                  v-else-if="user?.username"
                  class="text-xs font-semibold"
                >
                  {{ userInitial }}
                </span>
                <AppIcon v-else name="user" class="h-4 w-4" />
              </template>
              <AppIcon v-else-if="msg.role === 'assistant'" name="bot" class="h-4 w-4" />
              <AppIcon v-else name="info" class="h-4 w-4" />

              <!-- Telegram badge (source or delivered) -->
              <span
                v-if="msg.source === 'telegram' || msg.telegramDelivered"
                class="absolute -bottom-0.5 -right-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-[#2AABEE] text-white shadow-sm"
                :title="msg.source === 'telegram' ? (msg.senderName ? `via Telegram (${msg.senderName})` : 'via Telegram') : 'Also sent via Telegram'"
              >
                <svg class="h-2 w-2" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 0C5.37 0 0 5.37 0 12s5.37 12 12 12 12-5.37 12-12S18.63 0 12 0zm5.53 7.18l-1.97 9.3c-.15.67-.54.83-1.09.52l-3.01-2.22-1.45 1.4c-.16.16-.3.3-.61.3l.22-3.05 5.55-5.02c.24-.22-.05-.34-.38-.13l-6.87 4.33-2.96-.93c-.64-.2-.66-.64.13-.95l11.57-4.46c.54-.19 1.01.13.87.91z"/>
                </svg>
              </span>
            </div>

            <!-- Bubble -->
            <div
              class="min-w-0 rounded-2xl px-4 py-2.5 text-sm leading-relaxed"
              :class="{
                'rounded-br-sm border border-primary/[0.22] bg-primary/[0.12] text-foreground': msg.role === 'user' && msg.source !== 'telegram',
                'rounded-br-sm border border-[#2AABEE]/30 bg-[#2AABEE]/10 text-foreground': msg.role === 'user' && msg.source === 'telegram',
                'rounded-bl-sm border border-border bg-muted text-foreground': msg.role === 'assistant' && !msg.telegramDelivered,
                'rounded-bl-sm border border-[#2AABEE]/30 bg-[#2AABEE]/10 text-foreground': msg.role === 'assistant' && msg.telegramDelivered,
                'rounded-lg border border-border bg-muted/50 text-muted-foreground text-xs': msg.role === 'system',
              }"
            >
              <!-- Telegram label (source or delivered) -->
              <p v-if="msg.source === 'telegram'" class="mb-1 text-xs font-medium text-[#2AABEE]">
                via Telegram{{ msg.senderName ? ` (${msg.senderName})` : '' }}
              </p>
              <p v-else-if="msg.telegramDelivered" class="mb-1 text-xs font-medium text-[#2AABEE]">
                via Telegram
              </p>
              <!-- Markdown rendered content for assistant, plain text for user/system -->
              <div
                v-if="msg.role === 'assistant'"
                class="prose-chat break-words"
                v-html="renderMarkdown(msg.content ?? '')"
              />
              <p v-else class="whitespace-pre-wrap break-words">{{ msg.content }}</p>

              <!-- Typing indicator (animated dots when streaming) -->
              <div v-if="msg.streaming" class="mt-1.5 flex items-center gap-1" :aria-label="$t('chat.typing')">
                <span class="h-1.5 w-1.5 animate-[typingDot_1.4s_ease-in-out_infinite] rounded-full bg-current opacity-60" />
                <span class="h-1.5 w-1.5 animate-[typingDot_1.4s_ease-in-out_0.2s_infinite] rounded-full bg-current opacity-60" />
                <span class="h-1.5 w-1.5 animate-[typingDot_1.4s_ease-in-out_0.4s_infinite] rounded-full bg-current opacity-60" />
              </div>

              <!-- Timestamp -->
              <p
                v-if="msg.timestamp && !msg.streaming"
                class="mt-1 text-right text-[10px] leading-none"
                :class="{
                  'text-muted-foreground/70': msg.role === 'user' && msg.source !== 'telegram',
                  'text-muted-foreground/70': msg.role !== 'user' || msg.source === 'telegram',
                }"
              >
                {{ formatMessageTime(msg.timestamp) }}
              </p>
            </div>
          </template>
        </div>
      </template>
    </div>

    <!-- Scroll-to-bottom FAB -->
    <Transition
      enter-active-class="transition duration-200 ease-out"
      enter-from-class="translate-y-2 opacity-0"
      enter-to-class="translate-y-0 opacity-100"
      leave-active-class="transition duration-150 ease-in"
      leave-from-class="translate-y-0 opacity-100"
      leave-to-class="translate-y-2 opacity-0"
    >
      <button
        v-if="!isNearBottom"
        class="absolute bottom-20 right-6 z-10 flex h-9 w-9 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-md transition-colors hover:bg-muted hover:text-foreground"
        :aria-label="$t('chat.scrollToBottom')"
        @click="jumpToBottom"
      >
        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
    </Transition>

    <!-- Input area -->
    <div class="shrink-0 border-t border-border bg-background p-3">
      <form class="flex items-end gap-2" @submit.prevent="handleSend">
        <textarea
          ref="inputRef"
          v-model="inputText"
          class="min-h-[42px] max-h-[150px] flex-1 resize-none rounded-xl border border-input bg-background px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground outline-none ring-offset-background transition-colors focus:border-ring focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          :placeholder="$t('chat.placeholder')"
          rows="1"
          :aria-label="$t('chat.placeholder')"
          @keydown.enter.exact.prevent="handleSend"
          @input="autoResize"
        />
        <Button
          type="submit"
          size="sm"
          :disabled="!inputText.trim() || connectionStatus !== 'connected'"
          class="h-[42px] shrink-0 px-4"
        >
          {{ $t('chat.send') }}
        </Button>
      </form>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { ChatMessage, ToolCallData } from '~/composables/useChat'

const { t } = useI18n()
const { apiFetch } = useApi()
const { user } = useAuth()
const { userAvatarUrl, avatarFailed, userInitial, onAvatarError } = useUserAvatar()
const { renderMarkdown, handleCopyAsMarkdown } = useMarkdown()
const { isSkillLoad, getSkillName, extractSkillContent } = useSkillDetection()

function isToolSkillLoad(toolData: ToolCallData): boolean {
  return isSkillLoad(toolData.toolName, toolData.toolArgs)
}

function toolDisplayName(toolData: ToolCallData): string {
  if (isToolSkillLoad(toolData)) {
    const name = getSkillName(toolData.toolArgs)
    return `Load Skill: ${name}`
  }
  return toolData.toolName
}

// Track which tool calls are expanded
const expandedTools = ref<Set<string>>(new Set())

function toggleTool(toolCallId: string) {
  const updated = new Set(expandedTools.value)
  if (updated.has(toolCallId)) {
    updated.delete(toolCallId)
  } else {
    updated.add(toolCallId)
  }
  expandedTools.value = updated
}

// Extract the body (skip the first title line) for task result notifications
function taskResultBody(content: string): string {
  const lines = (content ?? '').split('\n')
  // Skip the first line (title like "✅ Task completed: ...") and any blank lines after
  const bodyLines = lines.slice(1)
  while (bodyLines.length > 0 && bodyLines[0].trim() === '') bodyLines.shift()
  return bodyLines.join('\n') || content
}

// Track which task result notifications are expanded
const expandedInjections = ref<Set<number>>(new Set())

function toggleInjection(index: number) {
  const updated = new Set(expandedInjections.value)
  if (updated.has(index)) {
    updated.delete(index)
  } else {
    updated.add(index)
  }
  expandedInjections.value = updated
}

function formatToolData(data: unknown): string {
  if (data === null || data === undefined) return '—'
  if (typeof data === 'string') return data
  try {
    return JSON.stringify(data, null, 2)
  } catch {
    return String(data)
  }
}


const {
  messages,
  connectionStatus,
  isStreaming,
  connect,
  disconnect,
  sendMessage,
  newSession,
  stopTask,
} = useChat()

const chatStatusText = computed(() => {
  switch (connectionStatus.value) {
    case 'connected': return t('chat.statusConnected')
    case 'connecting': return t('chat.statusConnecting')
    default: return t('chat.statusDisconnected')
  }
})

const inputText = ref('')
const inputRef = ref<HTMLTextAreaElement | null>(null)
const messagesContainer = ref<HTMLDivElement | null>(null)
const loadingHistory = ref(false)

// Smart auto-scroll: only scroll when user is near bottom
const isNearBottom = ref(true)
const SCROLL_THRESHOLD = 120 // px from bottom to count as "near bottom"

function onMessagesScroll() {
  const el = messagesContainer.value
  if (!el) return
  const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
  isNearBottom.value = distanceFromBottom <= SCROLL_THRESHOLD
}

function jumpToBottom() {
  isNearBottom.value = true
  nextTick(() => scrollToBottom())
}

// Connect WebSocket on mount
onMounted(async () => {
  connect()
  await loadHistory()
})

onUnmounted(() => {
  disconnect()
})

// Auto-scroll to bottom when new messages arrive (only if user is near bottom)
watch(
  () => messages.value.length,
  (_newLen, oldLen) => {
    // Always scroll for user's own message (last added is 'user')
    const lastMsg = messages.value[messages.value.length - 1]
    const isOwnMessage = lastMsg?.role === 'user' && lastMsg.source !== 'telegram'
    if (isNearBottom.value || isOwnMessage) {
      nextTick(() => scrollToBottom())
    }
  }
)

// Also watch for streaming content changes (only if near bottom)
watch(
  () => {
    const last = messages.value[messages.value.length - 1]
    return last?.content?.length ?? 0
  },
  () => {
    if (isNearBottom.value) {
      nextTick(() => scrollToBottom())
    }
  }
)

async function loadHistory() {
  loadingHistory.value = true
  try {
    interface HistoryResponse {
      messages: Array<{
        id: number
        role: 'user' | 'assistant' | 'tool' | 'system'
        content: string
        metadata?: string
        timestamp: string
        session_id: string
      }>
    }

    const data = await apiFetch<HistoryResponse>('/api/chat/history?limit=50')
    if (data.messages && data.messages.length > 0) {
      // Messages come in DESC order, reverse for display
      const historyMessages = data.messages.reverse().map((m) => {
        const base: ChatMessage = {
          id: m.id,
          role: m.role,
          content: m.content,
          timestamp: m.timestamp,
          // Derive source from session_id prefix
          source: m.session_id.startsWith('telegram-') ? 'telegram' as const : undefined,
        }
        // Parse system messages with session_divider or task_result metadata
        if (m.role === 'system' && m.metadata) {
          try {
            const meta = JSON.parse(m.metadata)
            if (meta.type === 'session_divider') {
              base.role = 'divider'
              base.content = meta.summary ?? ''
            } else if (meta.type === 'task_result') {
              base.isTaskResult = true
              base.taskResultName = meta.taskName ?? 'Background Task'
              base.taskResultStatus = meta.taskResultStatus ?? meta.taskStatus ?? 'completed'
              base.taskResultDuration = meta.durationMinutes
            }
          } catch { /* ignore */ }
        }
        // Parse tool metadata from DB
        if (m.role === 'tool' && m.metadata) {
          try {
            base.toolData = JSON.parse(m.metadata)
          } catch { /* ignore */ }
        }
        // Parse telegramDelivered and isTaskInjection from task injection response metadata
        if (m.role === 'assistant' && m.metadata) {
          try {
            const meta = JSON.parse(m.metadata)
            if (meta.telegramDelivered) {
              base.telegramDelivered = true
            }
            if (meta.type === 'task_injection_response') {
              base.isTaskInjection = true
            }
          } catch { /* ignore */ }
        }
        return base
      })
      messages.value = historyMessages
    }
  } catch {
    // History load failed — not critical, just start fresh
  } finally {
    loadingHistory.value = false
    nextTick(() => scrollToBottom())
  }
}

function handleSend() {
  const text = inputText.value.trim()
  if (!text || connectionStatus.value !== 'connected') return

  sendMessage(text)
  inputText.value = ''

  // Reset textarea height
  if (inputRef.value) {
    inputRef.value.style.height = 'auto'
  }
}

function handleNewSession() {
  newSession()
}

function handleStop() {
  stopTask()
}

function scrollToBottom() {
  if (messagesContainer.value) {
    messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight
  }
}

function autoResize() {
  const el = inputRef.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 150) + 'px'
}

function formatMessageTime(timestamp: string): string {
  if (!timestamp) return ''
  const d = new Date(timestamp)
  if (isNaN(d.getTime())) return ''

  const now = new Date()
  const isToday = d.toDateString() === now.toDateString()

  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

  if (isToday) return time

  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ' ' + time
}
</script>
