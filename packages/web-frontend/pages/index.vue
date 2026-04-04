<template>
  <div class="relative flex h-full flex-col overflow-hidden">
    <div class="flex shrink-0 items-center gap-2 border-b border-border bg-background px-6 py-2">
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
      <Button variant="outline" size="sm" class="gap-2 hover:border-destructive hover:text-destructive" :disabled="!isStreaming" @click="handleStop">
        <AppIcon name="square" class="h-4 w-4" />
        <span class="hidden sm:inline">{{ $t('chat.stop') }}</span>
      </Button>
      <Button variant="outline" size="sm" class="gap-2" @click="handleNewSession">
        <AppIcon name="sparkles" class="h-4 w-4" />
        <span class="hidden sm:inline">{{ $t('chat.newSession') }}</span>
      </Button>
    </div>

    <div ref="messagesContainer" class="relative flex flex-1 flex-col gap-4 overflow-y-auto p-4" @scroll="onMessagesScroll" @copy="handleCopyAsMarkdown">
      <div v-if="loadingHistory" class="flex flex-col gap-3">
        <div class="flex items-start gap-3 self-start"><Skeleton class="h-8 w-8 shrink-0 rounded-full" /><div class="space-y-2"><Skeleton class="h-4 w-48 rounded-xl" /><Skeleton class="h-4 w-64 rounded-xl" /></div></div>
      </div>
      <div v-else-if="messages.length === 0" class="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
        <AppIcon name="chat" class="h-10 w-10 opacity-40" />
        <p class="text-sm">{{ $t('chat.noMessages') }}</p>
      </div>
      <template v-else>
        <div
          v-for="(msg, i) in filteredMessages"
          :key="i"
          :class="[
            msg.role === 'divider' ? 'w-full' : (msg.role === 'tool' || (msg.role === 'system' && msg.isTaskResult)) ? 'self-start w-full max-w-[80%] sm:max-w-[75%] pl-11' : 'flex max-w-[80%] gap-3 sm:max-w-[75%]',
            {
              'self-end flex-row-reverse': msg.role === 'user',
              'self-start': msg.role === 'assistant',
              'self-center max-w-[90%] !sm:max-w-[85%]': msg.role === 'system' && !msg.isTaskResult,
            },
          ]"
        >
          <template v-if="msg.role === 'tool' && msg.toolData">
            <div class="w-full overflow-hidden rounded-lg border border-border">
              <button class="group flex w-full items-center gap-2 bg-muted/30 px-3 py-1.5 text-left text-xs text-muted-foreground" :class="{ 'border-b border-border': expandedTools.has(msg.toolData!.toolCallId) }" @click="toggleTool(msg.toolData!.toolCallId)">
                <svg class="h-3 w-3 shrink-0 transition-transform duration-200" :class="{ 'rotate-90': expandedTools.has(msg.toolData!.toolCallId) }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6" /></svg>
                <AppIcon :name="isToolSkillLoad(msg.toolData!) ? 'puzzle' : 'settings'" class="h-3 w-3 shrink-0 opacity-60" />
                <span class="font-medium">{{ toolDisplayName(msg.toolData!) }}</span>
              </button>
              <div v-if="expandedTools.has(msg.toolData!.toolCallId)" class="bg-background text-xs">
                <div v-if="!isToolSkillLoad(msg.toolData!)" class="border-b border-border px-3 py-2"><p class="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Input</p><ToolDataDisplay :data="msg.toolData!.toolArgs" /></div>
                <div class="max-h-60 overflow-y-auto px-3 py-2"><p class="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Output</p><ToolDataDisplay :data="msg.toolData!.toolResult" :is-error="msg.toolData!.toolIsError" /></div>
              </div>
            </div>
          </template>
          <template v-else>
            <div class="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-muted-foreground">
              <template v-if="msg.role === 'user'">
                <img v-if="userAvatarUrl && !avatarFailed" :src="userAvatarUrl" :alt="user?.username" class="h-8 w-8 rounded-full object-cover" @error="onAvatarError">
                <span v-else-if="user?.username" class="text-xs font-semibold">{{ userInitial }}</span>
                <AppIcon v-else name="user" class="h-4 w-4" />
              </template>
              <AppIcon v-else-if="msg.role === 'assistant'" name="bot" class="h-4 w-4" />
              <AppIcon v-else name="info" class="h-4 w-4" />
            </div>
            <div class="min-w-0 rounded-2xl px-4 py-2.5 text-sm leading-relaxed" :class="{
              'rounded-br-sm border border-primary/[0.22] bg-primary/[0.12] text-foreground': msg.role === 'user' && msg.source !== 'telegram',
              'rounded-br-sm border border-[#2AABEE]/30 bg-[#2AABEE]/10 text-foreground': msg.role === 'user' && msg.source === 'telegram',
              'rounded-bl-sm border border-border bg-muted text-foreground': msg.role === 'assistant' && !msg.telegramDelivered,
              'rounded-bl-sm border border-[#2AABEE]/30 bg-[#2AABEE]/10 text-foreground': msg.role === 'assistant' && msg.telegramDelivered,
              'rounded-lg border border-border bg-muted/50 text-muted-foreground text-xs': msg.role === 'system',
            }">
              <div v-if="msg.role === 'assistant'" class="prose-chat break-words" v-html="renderMarkdown(msg.content ?? '')" />
              <p v-else class="whitespace-pre-wrap break-words">{{ msg.content }}</p>
              <ChatAttachments v-if="msg.attachments?.length" :attachments="msg.attachments" />
              <div v-if="msg.streaming" class="mt-1.5 flex items-center gap-1"><span class="h-1.5 w-1.5 animate-pulse rounded-full bg-current opacity-60" /><span class="h-1.5 w-1.5 animate-pulse rounded-full bg-current opacity-60" /><span class="h-1.5 w-1.5 animate-pulse rounded-full bg-current opacity-60" /></div>
              <p v-if="msg.timestamp && !msg.streaming" class="mt-1 text-right text-[10px] leading-none text-muted-foreground/70">{{ formatMessageTime(msg.timestamp) }}</p>
            </div>
          </template>
        </div>
      </template>
    </div>

    <Transition enter-active-class="transition duration-200 ease-out" enter-from-class="translate-y-2 opacity-0" enter-to-class="translate-y-0 opacity-100" leave-active-class="transition duration-150 ease-in" leave-from-class="translate-y-0 opacity-100" leave-to-class="translate-y-2 opacity-0">
      <button v-if="!isNearBottom" class="absolute bottom-28 right-6 z-10 flex h-9 w-9 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-md" @click="jumpToBottom">
        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9" /></svg>
      </button>
    </Transition>

    <div class="shrink-0 border-t border-border bg-background p-3">
      <form class="flex flex-col gap-2" @submit.prevent="handleSend">
        <div v-if="pendingFiles.length" class="flex flex-wrap gap-2">
          <div v-for="(file, index) in pendingFiles" :key="`${file.name}-${index}`" class="inline-flex items-center gap-2 rounded-full border border-border bg-muted px-3 py-1 text-xs">
            <span>{{ file.name }}</span>
            <button type="button" class="text-muted-foreground hover:text-foreground" @click="removePendingFile(index)">×</button>
          </div>
        </div>
        <div class="flex items-end gap-2">
          <label class="inline-flex h-[42px] cursor-pointer items-center rounded-xl border border-input px-3 text-sm text-muted-foreground hover:bg-muted">
            <input class="hidden" type="file" multiple @change="handleFileSelection">
            <AppIcon name="paperclip" class="h-4 w-4" />
          </label>
          <textarea ref="inputRef" v-model="inputText" class="min-h-[42px] max-h-[150px] flex-1 resize-none rounded-xl border border-input bg-background px-3.5 py-2.5 text-sm" :placeholder="$t('chat.placeholder')" rows="1" @keydown.enter.exact.prevent="handleSend" @input="autoResize" />
          <Button type="submit" size="sm" :disabled="(!inputText.trim() && pendingFiles.length === 0) || connectionStatus !== 'connected'" class="h-[42px] shrink-0 px-4">{{ $t('chat.send') }}</Button>
        </div>
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
const { isSkillLoad, getSkillName } = useSkillDetection()
function isToolSkillLoad(toolData: ToolCallData): boolean { return isSkillLoad(toolData.toolName, toolData.toolArgs) }
function toolDisplayName(toolData: ToolCallData): string { return isToolSkillLoad(toolData) ? `Load Skill: ${getSkillName(toolData.toolArgs)}` : toolData.toolName }
const filteredMessages = computed(() => messages.value)
const expandedTools = ref<Set<string>>(new Set())
function toggleTool(toolCallId: string) { const updated = new Set(expandedTools.value); updated.has(toolCallId) ? updated.delete(toolCallId) : updated.add(toolCallId); expandedTools.value = updated }
const { messages, connectionStatus, isStreaming, connect, disconnect, sendMessage, newSession, stopTask } = useChat()
const chatStatusText = computed(() => connectionStatus.value === 'connected' ? t('chat.statusConnected') : connectionStatus.value === 'connecting' ? t('chat.statusConnecting') : t('chat.statusDisconnected'))
const inputText = ref('')
const pendingFiles = ref<File[]>([])
const inputRef = ref<HTMLTextAreaElement | null>(null)
const messagesContainer = ref<HTMLDivElement | null>(null)
const loadingHistory = ref(false)
const isNearBottom = ref(true)
const SCROLL_THRESHOLD = 120
function onMessagesScroll() { const el = messagesContainer.value; if (!el) return; isNearBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight <= SCROLL_THRESHOLD }
function jumpToBottom() { isNearBottom.value = true; nextTick(() => scrollToBottom()) }
onMounted(async () => { connect(); await loadHistory() })
onUnmounted(() => { disconnect() })
watch(() => messages.value.length, () => { if (isNearBottom.value) nextTick(() => scrollToBottom()) })
watch(() => messages.value[messages.value.length - 1]?.content?.length ?? 0, () => { if (isNearBottom.value) nextTick(() => scrollToBottom()) })
async function loadHistory() {
  loadingHistory.value = true
  try {
    const data = await apiFetch<{ messages: Array<{ id: number; role: 'user' | 'assistant' | 'tool' | 'system'; content: string; metadata?: string; timestamp: string; session_id: string }> }>('/api/chat/history?limit=50')
    if (data.messages?.length) {
      messages.value = data.messages.reverse().map((m) => {
        const meta = (() => { try { return JSON.parse(m.metadata || '{}') } catch { return {} } })()
        const attachments = (Array.isArray(meta.files) ? meta.files : []) as ChatMessage['attachments']
        const source = m.session_id.startsWith('telegram-') ? 'telegram' as const : undefined

        // Reconstruct tool messages with toolData from metadata
        if (m.role === 'tool' && meta.toolName) {
          return {
            id: m.id, role: 'tool' as const, content: m.content, timestamp: m.timestamp, source,
            toolData: { toolName: meta.toolName, toolCallId: meta.toolCallId ?? '', toolArgs: meta.toolArgs, toolResult: meta.toolResult, toolIsError: meta.toolIsError },
          } as ChatMessage
        }

        return { id: m.id, role: m.role, content: m.content, timestamp: m.timestamp, source, attachments } as ChatMessage
      })
    }
  } finally { loadingHistory.value = false; nextTick(() => scrollToBottom()) }
}
async function handleSend() {
  const files = [...pendingFiles.value]
  const text = inputText.value
  if ((!text.trim() && files.length === 0) || connectionStatus.value !== 'connected') return
  await sendMessage(text, files)
  inputText.value = ''
  pendingFiles.value = []
  if (inputRef.value) inputRef.value.style.height = 'auto'
}
function handleNewSession() { newSession() }
function handleStop() { stopTask() }
function scrollToBottom() { if (messagesContainer.value) messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight }
function autoResize() { const el = inputRef.value; if (!el) return; el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 150) + 'px' }
function handleFileSelection(event: Event) { const target = event.target as HTMLInputElement; const files = Array.from(target.files || []); pendingFiles.value = [...pendingFiles.value, ...files]; target.value = '' }
function removePendingFile(index: number) { pendingFiles.value.splice(index, 1) }
function formatMessageTime(timestamp: string): string { const d = new Date(timestamp); if (isNaN(d.getTime())) return ''; return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) }

</script>
