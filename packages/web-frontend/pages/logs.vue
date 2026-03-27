<template>
  <div class="flex h-full flex-col overflow-hidden">
    <PageHeader :title="$t('logs.title')" :subtitle="$t('logs.subtitle')">
      <template #actions>
        <!-- Live / Historical toggle -->
        <Button
          :variant="liveMode ? 'default' : 'outline'"
          size="sm"
          class="gap-1.5"
          @click="toggleLiveMode"
        >
          <span
            class="h-2 w-2 rounded-full"
            :class="liveMode ? 'bg-primary-foreground' : 'bg-muted-foreground'"
            :style="liveMode && !paused ? 'animation: pulse-dot 1.5s ease-in-out infinite' : ''"
          />
          {{ liveMode ? $t('logs.live') : $t('logs.historical') }}
        </Button>

        <!-- Pause / Resume (live mode only) -->
        <Button
          v-if="liveMode"
          :variant="paused ? 'outline' : 'ghost'"
          size="sm"
          :class="paused ? 'border-warning text-warning' : ''"
          @click="togglePause()"
        >
          {{ paused ? $t('logs.resume') : $t('logs.pause') }}
        </Button>
      </template>
    </PageHeader>

    <!-- Filter toolbar -->
    <div class="flex-shrink-0 border-b border-border px-5 py-4">
      <!-- Filters row -->
      <div class="flex flex-wrap gap-2">
        <Input
          v-model="searchQuery"
          type="text"
          :placeholder="$t('logs.searchPlaceholder')"
          class="min-w-[180px] flex-1"
          @input="debouncedSearch"
        />

        <Select v-model="selectedToolName" class="w-[150px]" @change="applyFilters">
          <option value="">{{ $t('logs.allTools') }}</option>
          <option v-for="name in toolNames" :key="name" :value="name">{{ name }}</option>
        </Select>

        <Input
          v-model="dateFrom"
          type="date"
          class="w-[145px]"
          :aria-label="$t('logs.dateFrom')"
          @change="applyFilters"
        />
        <Input
          v-model="dateTo"
          type="date"
          class="w-[145px]"
          :aria-label="$t('logs.dateTo')"
          @change="applyFilters"
        />
      </div>
    </div>

    <!-- Loading state -->
    <div
      v-if="loading && logs.length === 0"
      class="flex flex-1 items-center justify-center py-20 text-sm text-muted-foreground"
    >
      {{ $t('logs.loading') }}
    </div>

    <!-- Empty state -->
    <div
      v-else-if="!loading && logs.length === 0"
      class="flex flex-1 flex-col items-center justify-center gap-3 py-20 text-muted-foreground"
    >
      <AppIcon name="logs" size="xl" class="opacity-40" />
      <p class="text-sm">{{ $t('logs.noEntries') }}</p>
    </div>

    <!-- Log entries -->
    <div v-else ref="logsListRef" class="flex-1 overflow-y-auto">
      <div
        v-for="entry in logs"
        :key="entry.id"
        class="cursor-pointer border-b border-border transition-colors hover:bg-muted/40"
        :class="{
          'border-l-2 border-l-destructive': entry.status === 'error',
          'bg-muted/20': expandedId === entry.id,
        }"
        @click="toggleExpand(entry.id)"
      >
        <!-- Main row -->
        <div class="flex items-center gap-3 px-5 py-2.5 text-sm">
          <!-- Timestamp -->
          <span class="w-[130px] shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
            {{ formatTimestamp(entry.timestamp) }}
          </span>

          <!-- Tool badge -->
          <Badge :class="toolBadgeClass(entry.toolName)" class="shrink-0 gap-1 font-mono text-xs">
            <AppIcon :name="toolIcon(entry.toolName)" class="h-3 w-3" />
            {{ entry.toolName }}
          </Badge>

          <!-- Input preview (hidden on small screens) -->
          <span class="hidden min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground sm:block">
            {{ entry.input || '—' }}
          </span>

          <!-- Duration -->
          <span class="w-14 shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground">
            {{ formatDuration(entry.durationMs) }}
          </span>

          <!-- Status icon -->
          <span class="flex w-5 shrink-0 items-center justify-center">
            <AppIcon
              :name="entry.status === 'success' ? 'success' : 'warning'"
              class="h-4 w-4"
              :class="entry.status === 'success' ? 'text-success' : 'text-destructive'"
            />
          </span>

          <!-- Expand chevron -->
          <span class="flex w-4 shrink-0 items-center justify-center text-muted-foreground">
            <AppIcon :name="expandedId === entry.id ? 'chevronDown' : 'chevronRight'" class="h-4 w-4" />
          </span>
        </div>

        <!-- Expanded detail panel -->
        <div
          v-if="expandedId === entry.id"
          class="border-t border-border bg-background px-5 pb-4 pt-3"
          @click.stop
        >
          <div v-if="detailLoading" class="py-3 text-sm text-muted-foreground">
            {{ $t('logs.loading') }}
          </div>

          <template v-else-if="expandedDetail">
            <!-- Input -->
            <div class="mb-3">
              <h4 class="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {{ $t('logs.input') }}
              </h4>
              <pre
                class="max-h-[200px] overflow-y-auto rounded-md border border-border bg-muted/50 p-3 font-mono text-xs leading-relaxed text-foreground whitespace-pre-wrap break-all"
              >{{ expandedDetail.input || '—' }}</pre>
            </div>

            <!-- Output -->
            <div class="mb-3">
              <h4 class="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {{ $t('logs.output') }}
              </h4>
              <pre
                class="max-h-[300px] overflow-y-auto rounded-md border border-border bg-muted/50 p-3 font-mono text-xs leading-relaxed text-foreground whitespace-pre-wrap break-all"
              >{{ expandedDetail.output || '—' }}</pre>
            </div>

            <!-- Meta row -->
            <div class="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
              <span>{{ $t('logs.sessionId') }}: {{ expandedDetail.sessionId }}</span>
              <span>{{ $t('logs.duration') }}: {{ formatDuration(expandedDetail.durationMs) }}</span>
              <span>{{ $t('logs.status') }}: {{ expandedDetail.status }}</span>
            </div>
          </template>
        </div>
      </div>
    </div>

    <!-- Pagination (historical mode only) -->
    <div
      v-if="!liveMode && pagination.totalPages > 1"
      class="flex flex-shrink-0 items-center justify-center gap-4 border-t border-border px-5 py-3"
    >
      <Button
        variant="outline"
        size="sm"
        :disabled="pagination.page <= 1"
        class="gap-1"
        @click="goToPage(pagination.page - 1)"
      >
        <AppIcon name="arrowLeft" class="h-4 w-4" />
        {{ $t('logs.prev') }}
      </Button>

      <span class="text-sm text-muted-foreground">
        {{ $t('logs.pageInfo', { page: pagination.page, total: pagination.totalPages }) }}
      </span>

      <Button
        variant="outline"
        size="sm"
        :disabled="pagination.page >= pagination.totalPages"
        class="gap-1"
        @click="goToPage(pagination.page + 1)"
      >
        {{ $t('logs.next') }}
        <AppIcon name="arrowRight" class="h-4 w-4" />
      </Button>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { LogEntry } from '~/composables/useLogs'

const {
  logs,
  pagination,
  toolNames,
  loading,
  liveMode,
  paused,
  fetchLogs,
  fetchLogDetail,
  fetchToolNames,
  connectLive,
  disconnectLive,
  togglePause,
  setLiveMode,
} = useLogs()

const searchQuery = ref('')
const selectedToolName = ref('')
const dateFrom = ref('')
const dateTo = ref('')
const expandedId = ref<number | null>(null)
const expandedDetail = ref<LogEntry | null>(null)
const detailLoading = ref(false)
const logsListRef = ref<HTMLElement | null>(null)

let searchTimeout: ReturnType<typeof setTimeout> | null = null

function debouncedSearch() {
  if (searchTimeout) clearTimeout(searchTimeout)
  searchTimeout = setTimeout(() => applyFilters(), 300)
}

async function applyFilters() {
  if (liveMode.value) {
    setLiveMode(false)
  }
  await fetchLogs({
    page: 1,
    search: searchQuery.value || undefined,
    toolName: selectedToolName.value || undefined,
    dateFrom: dateFrom.value || undefined,
    dateTo: dateTo.value || undefined,
  })
}

function toggleLiveMode() {
  if (liveMode.value) {
    setLiveMode(false)
    fetchLogs()
  } else {
    setLiveMode(true)
    fetchLogs()
  }
}

async function toggleExpand(id: number) {
  if (expandedId.value === id) {
    expandedId.value = null
    expandedDetail.value = null
    return
  }
  expandedId.value = id
  expandedDetail.value = null
  detailLoading.value = true
  try {
    expandedDetail.value = await fetchLogDetail(id)
  } finally {
    detailLoading.value = false
  }
}

function goToPage(page: number) {
  fetchLogs({
    page,
    search: searchQuery.value || undefined,
    toolName: selectedToolName.value || undefined,
    dateFrom: dateFrom.value || undefined,
    dateTo: dateTo.value || undefined,
  })
}

function formatTimestamp(ts: string): string {
  if (!ts) return ''
  const d = new Date(ts + (ts.includes('Z') || ts.includes('+') ? '' : 'Z'))
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function toolBadgeClass(name: string): string {
  if (!name) return 'border-transparent bg-primary/15 text-primary'
  const lower = name.toLowerCase()
  if (lower.includes('bash') || lower.includes('exec') || lower.includes('command'))
    return 'border-transparent bg-warning/15 text-warning'
  if (lower.includes('file') || lower.includes('read') || lower.includes('write') || lower.includes('edit'))
    return 'border-transparent bg-blue-500/15 text-blue-500'
  if (lower.includes('llm') || lower.includes('chat') || lower.includes('generate'))
    return 'border-transparent bg-purple-500/15 text-purple-500'
  return 'border-transparent bg-primary/15 text-primary'
}

function toolIcon(name: string): 'activity' | 'file' | 'brain' | 'wrench' {
  if (!name) return 'wrench'
  const lower = name.toLowerCase()
  if (lower.includes('bash') || lower.includes('exec') || lower.includes('command')) return 'activity'
  if (lower.includes('file') || lower.includes('read') || lower.includes('write') || lower.includes('edit')) return 'file'
  if (lower.includes('llm') || lower.includes('chat') || lower.includes('generate')) return 'brain'
  return 'wrench'
}

onMounted(async () => {
  await fetchToolNames()
  await fetchLogs()
  if (liveMode.value) {
    connectLive()
  }
})

onUnmounted(() => {
  disconnectLive()
})
</script>
