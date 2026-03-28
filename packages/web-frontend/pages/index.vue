<template>
  <div class="flex h-full flex-col overflow-hidden">
    <!-- Chat toolbar -->
    <div class="flex shrink-0 items-center gap-2 border-b border-border bg-background px-4 py-2">
      <Button variant="outline" size="sm" class="gap-2" @click="handleNewSession">
        <AppIcon name="sparkles" class="h-4 w-4" />
        <span class="hidden sm:inline">{{ $t('chat.newSession') }}</span>
      </Button>
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
    </div>

    <!-- Messages area -->
    <div ref="messagesContainer" class="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
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
          class="flex max-w-[80%] gap-3 animate-in fade-in slide-in-from-bottom-2 duration-200 sm:max-w-[75%]"
          :class="{
            'self-end flex-row-reverse': msg.role === 'user',
            'self-start': msg.role === 'assistant',
            'self-center max-w-[90%] sm:max-w-[85%]': msg.role === 'system',
          }"
        >
          <!-- Avatar -->
          <div
            class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-muted-foreground overflow-hidden"
          >
            <!-- User avatar -->
            <template v-if="msg.role === 'user'">
              <img
                v-if="userAvatarUrl && !avatarFailed"
                :src="userAvatarUrl"
                :alt="user?.username"
                class="h-8 w-8 object-cover"
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
          </div>

          <!-- Bubble -->
          <div
            class="rounded-2xl px-4 py-2.5 text-sm leading-relaxed"
            :class="{
              'rounded-br-sm bg-primary text-primary-foreground': msg.role === 'user',
              'rounded-bl-sm border border-border bg-muted text-foreground': msg.role === 'assistant',
              'rounded-lg border border-border bg-muted/50 text-muted-foreground text-xs': msg.role === 'system',
            }"
          >
            <p class="whitespace-pre-wrap break-words">{{ msg.content }}</p>

            <!-- Typing indicator (animated dots when streaming) -->
            <div v-if="msg.streaming" class="mt-1.5 flex items-center gap-1" :aria-label="$t('chat.typing')">
              <span class="h-1.5 w-1.5 animate-[typingDot_1.4s_ease-in-out_infinite] rounded-full bg-current opacity-60" />
              <span class="h-1.5 w-1.5 animate-[typingDot_1.4s_ease-in-out_0.2s_infinite] rounded-full bg-current opacity-60" />
              <span class="h-1.5 w-1.5 animate-[typingDot_1.4s_ease-in-out_0.4s_infinite] rounded-full bg-current opacity-60" />
            </div>
          </div>
        </div>
      </template>
    </div>

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
const { t } = useI18n()
const { apiFetch } = useApi()
const { user } = useAuth()
const { userAvatarUrl, avatarFailed, userInitial, onAvatarError } = useUserAvatar()

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

const inputText = ref('')
const inputRef = ref<HTMLTextAreaElement | null>(null)
const messagesContainer = ref<HTMLDivElement | null>(null)
const loadingHistory = ref(false)

// Connect WebSocket on mount
onMounted(async () => {
  connect()
  await loadHistory()
})

onUnmounted(() => {
  disconnect()
})

// Auto-scroll to bottom when new messages arrive
watch(
  () => messages.value.length,
  () => {
    nextTick(() => {
      scrollToBottom()
    })
  }
)

// Also watch for streaming content changes
watch(
  () => {
    const last = messages.value[messages.value.length - 1]
    return last?.content?.length ?? 0
  },
  () => {
    nextTick(() => {
      scrollToBottom()
    })
  }
)

async function loadHistory() {
  loadingHistory.value = true
  try {
    interface HistoryResponse {
      messages: Array<{
        id: number
        role: 'user' | 'assistant'
        content: string
        timestamp: string
        session_id: string
      }>
    }

    const data = await apiFetch<HistoryResponse>('/api/chat/history?limit=50')
    if (data.messages && data.messages.length > 0) {
      // Messages come in DESC order, reverse for display
      const historyMessages = data.messages.reverse().map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        timestamp: m.timestamp,
      }))
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
</script>
