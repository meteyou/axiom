<template>
  <div class="flex h-full flex-col overflow-hidden">
    <!-- Header with back button -->
    <div class="flex-shrink-0 border-b border-border px-5 py-3">
      <div class="flex items-center gap-3">
        <Button variant="ghost" size="sm" class="gap-1.5" @click="$emit('back')">
          <AppIcon name="arrowLeft" size="sm" />
          {{ $t('taskViewer.back') }}
        </Button>

        <Separator orientation="vertical" class="h-5" />

        <div class="flex min-w-0 flex-1 items-center gap-2">
          <h2 class="truncate text-sm font-semibold">{{ taskInfo?.name ?? '—' }}</h2>
          <Badge v-if="taskInfo?.status" :variant="statusVariant(taskInfo.status)">
            {{ $t(`tasks.status.${taskInfo.status}`) }}
          </Badge>
          <Badge v-if="isLive" variant="default" class="gap-1">
            <span class="relative flex h-2 w-2">
              <span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
              <span class="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
            </span>
            {{ $t('taskViewer.live') }}
          </Badge>
        </div>
      </div>
    </div>

    <!-- Loading state -->
    <div v-if="loading" class="flex flex-1 flex-col items-center justify-center gap-3">
      <div class="h-8 w-8 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
      <span class="text-sm text-muted-foreground">{{ $t('taskViewer.loading') }}</span>
    </div>

    <!-- Error state -->
    <Alert v-else-if="error" variant="destructive" class="m-4">
      <AlertDescription>{{ error }}</AlertDescription>
    </Alert>

    <!-- Empty state -->
    <div
      v-else-if="events.length === 0"
      class="flex flex-1 flex-col items-center justify-center gap-3 p-10 text-center"
    >
      <AppIcon name="clock" size="xl" class="opacity-40" />
      <p class="text-sm text-muted-foreground">{{ $t('taskViewer.noEvents') }}</p>
    </div>

    <!-- Events list -->
    <div v-else ref="eventsContainer" class="flex flex-1 flex-col gap-1 overflow-y-auto px-5 py-3">
      <!-- Task prompt -->
      <div v-if="taskInfo?.prompt" class="rounded-lg border border-border bg-card px-4 py-3">
        <div class="flex items-start gap-3">
          <AppIcon name="send" size="sm" class="mt-0.5 text-primary" />
          <div class="min-w-0 flex-1">
            <p class="mb-1 text-xs font-medium text-primary">Prompt</p>
            <p class="text-sm text-foreground whitespace-pre-wrap">{{ taskInfo.prompt }}</p>
          </div>
        </div>
      </div>

      <div
        v-for="(event, idx) in groupedEvents"
        :key="idx"
        class="rounded-lg border border-border bg-card"
      >
        <!-- Tool call event -->
        <div v-if="event.type === 'tool_call_end' || event.type === 'tool_call_start'" class="group">
          <button
            class="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm transition-colors hover:bg-muted/50"
            @click="toggleExpanded(idx)"
          >
            <AppIcon
              name="wrench"
              size="sm"
              :class="event.toolIsError ? 'text-destructive' : 'text-muted-foreground'"
            />
            <span class="font-mono text-xs font-medium" :class="event.toolIsError ? 'text-destructive' : 'text-foreground'">
              {{ event.toolName ?? 'unknown' }}
            </span>
            <Badge v-if="event.toolIsError" variant="destructive" class="text-[10px] px-1.5 py-0">
              {{ $t('taskViewer.error') }}
            </Badge>
            <span v-if="event.durationMs != null" class="text-xs text-muted-foreground">
              {{ formatDurationMs(event.durationMs) }}
            </span>
            <span class="flex-1" />
            <span class="text-xs text-muted-foreground">
              {{ formatTimestamp(event.timestamp) }}
            </span>
            <AppIcon
              :name="expandedItems.has(idx) ? 'chevronDown' : 'chevronRight'"
              size="sm"
              class="text-muted-foreground"
            />
          </button>

          <!-- Expanded content -->
          <div v-if="expandedItems.has(idx)" class="border-t border-border bg-muted/20 px-4 py-3 space-y-3">
            <!-- Arguments -->
            <div v-if="event.toolArgs">
              <p class="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {{ $t('taskViewer.arguments') }}
              </p>
              <div class="rounded border border-border bg-background p-2.5 text-xs">
                <ToolDataDisplay :data="event.toolArgs" />
              </div>
            </div>

            <!-- Result -->
            <div v-if="event.type === 'tool_call_end' && event.toolResult !== undefined">
              <p class="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {{ $t('taskViewer.result') }}
              </p>
              <div class="max-h-[300px] overflow-y-auto rounded border border-border bg-background p-2.5 text-xs">
                <ToolDataDisplay :data="event.toolResult" :is-error="event.toolIsError" />
              </div>
            </div>
          </div>
        </div>

        <!-- Text delta event -->
        <div v-else-if="event.type === 'text_delta' && (event.text || event.thinking)" class="px-4 py-3 space-y-3">
          <!-- Thinking -->
          <div v-if="event.thinking" class="flex items-start gap-3">
            <AppIcon name="sparkles" size="sm" class="mt-0.5 text-muted-foreground/50" />
            <div class="min-w-0 flex-1">
              <button
                class="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors mb-1"
                @click="toggleThinking(idx)"
              >
                <AppIcon
                  :name="expandedThinking.has(idx) ? 'chevronDown' : 'chevronRight'"
                  size="sm"
                />
                {{ $t('taskViewer.thinking') }}
              </button>
              <div v-if="expandedThinking.has(idx)" class="rounded border border-border/50 bg-muted/30 p-2.5">
                <p class="whitespace-pre-wrap text-xs text-muted-foreground">{{ event.thinking }}</p>
              </div>
            </div>
          </div>
          <!-- Agent text -->
          <div v-if="event.text" class="flex items-start gap-3">
            <AppIcon name="bot" size="sm" class="mt-0.5 text-muted-foreground" />
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2 mb-1">
                <span class="text-xs font-medium text-muted-foreground">
                  {{ $t('taskViewer.agentResponse') }}
                </span>
                <span class="text-xs text-muted-foreground">
                  {{ formatTimestamp(event.timestamp) }}
                </span>
              </div>
              <!-- eslint-disable-next-line vue/no-v-html -->
              <div class="prose-chat text-sm" v-html="renderMarkdown(event.text)" />
            </div>
          </div>
        </div>

        <!-- Status change event -->
        <div v-else-if="event.type === 'status_change'" class="px-4 py-2.5">
          <div class="flex items-center gap-3">
            <AppIcon name="info" size="sm" class="text-muted-foreground" />
            <Badge :variant="statusVariant(event.status ?? '')">
              {{ $t(`tasks.status.${event.status}`) }}
            </Badge>
            <span v-if="event.statusMessage" class="text-sm text-muted-foreground truncate">
              {{ event.statusMessage }}
            </span>
            <span class="flex-1" />
            <span class="text-xs text-muted-foreground">
              {{ formatTimestamp(event.timestamp) }}
            </span>
          </div>
        </div>
      </div>

      <!-- Auto-scroll anchor -->
      <div ref="scrollAnchor" />
    </div>
  </div>
</template>

<script setup lang="ts">
import type { TaskEventItem } from '~/composables/useTaskViewer'

const props = defineProps<{
  taskId: string
}>()

defineEmits<{
  back: []
}>()

const { t } = useI18n()
const { renderMarkdown } = useMarkdown()

const {
  events,
  taskInfo,
  loading,
  error,
  isLive,
  loadTaskEvents,
  disconnect,
} = useTaskViewer()

// Expandable items
const expandedItems = ref(new Set<number>())
const expandedThinking = ref(new Set<number>())

function toggleExpanded(idx: number) {
  if (expandedItems.value.has(idx)) {
    expandedItems.value.delete(idx)
  } else {
    expandedItems.value.add(idx)
  }
  expandedItems.value = new Set(expandedItems.value)
}

function toggleThinking(idx: number) {
  if (expandedThinking.value.has(idx)) {
    expandedThinking.value.delete(idx)
  } else {
    expandedThinking.value.add(idx)
  }
  expandedThinking.value = new Set(expandedThinking.value)
}

/**
 * Group consecutive text_delta events into single blocks
 */
const groupedEvents = computed(() => {
  const result: TaskEventItem[] = []
  let pendingText: TaskEventItem | null = null

  for (const event of events.value) {
    if (event.type === 'text_delta' && event.text) {
      if (pendingText && pendingText.type === 'text_delta') {
        // Merge with previous text
        pendingText = Object.assign({}, pendingText, {
          text: (pendingText.text ?? '') + event.text,
        })
      } else {
        // Flush previous non-text event
        if (pendingText) result.push(pendingText)
        pendingText = Object.assign({}, event)
      }
    } else {
      // Flush pending text
      if (pendingText) {
        result.push(pendingText)
        pendingText = null
      }
      result.push(event)
    }
  }

  // Flush final pending text
  if (pendingText) result.push(pendingText)

  return result
})

// Auto-scroll to bottom when new events arrive (for live tasks)
const eventsContainer = ref<HTMLElement | null>(null)
const scrollAnchor = ref<HTMLElement | null>(null)

watch(() => events.value.length, () => {
  if (isLive.value) {
    nextTick(() => {
      scrollAnchor.value?.scrollIntoView({ behavior: 'smooth' })
    })
  }
})

// Status badge variant
function statusVariant(status: string): 'default' | 'success' | 'destructive' | 'warning' | 'muted' {
  switch (status) {
    case 'running': return 'default'
    case 'completed': return 'success'
    case 'failed': return 'destructive'
    case 'paused': return 'warning'
    default: return 'muted'
  }
}

function formatTimestamp(ts: string | undefined): string {
  if (!ts) return ''
  try {
    const date = new Date(ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z')
    return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  } catch {
    return ts
  }
}

function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

// Load events on mount
onMounted(() => {
  loadTaskEvents(props.taskId)
})

// Reload when taskId changes
watch(() => props.taskId, (newId) => {
  disconnect()
  expandedItems.value.clear()
  loadTaskEvents(newId)
})

onUnmounted(() => {
  disconnect()
})
</script>
