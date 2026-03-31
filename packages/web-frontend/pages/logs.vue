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
          class="min-w-[180px] flex-1 sm:flex-none"
          @input="debouncedSearch"
        />

        <Select v-model="selectedSourceFilter" class="w-[150px]" @change="applyFilters">
          <option value="">{{ $t('logs.allSources') }}</option>
          <option value="main">{{ $t('logs.sourceMainAgent') }}</option>
          <option value="task">{{ $t('logs.sourceTasks') }}</option>
        </Select>

        <Select v-model="selectedToolName" class="w-[150px]" @change="applyFilters">
          <option value="">{{ $t('logs.allTools') }}</option>
          <option v-for="name in toolNames" :key="name" :value="name">{{ name }}</option>
        </Select>

        <DateRangePicker
          v-model:date-from="dateFrom"
          v-model:date-to="dateTo"
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
          <span class="w-[150px] shrink-0 whitespace-nowrap font-mono text-xs tabular-nums text-muted-foreground">
            {{ formatTimestamp(entry.timestamp) }}
          </span>

          <!-- Tool badge -->
          <Badge
            :class="toolBadgeClass(entryDisplayName(entry))"
            class="h-[22px] shrink-0 gap-1 px-2 py-0 font-mono text-[11px] leading-none"
          >
            <AppIcon :name="toolIcon(entryDisplayName(entry))" class="h-3 w-3" />
            {{ entryDisplayName(entry) }}
          </Badge>

          <!-- Source badge (only for task sessions) -->
          <Badge
            v-if="isTaskSession(entry.sessionId)"
            class="hidden h-[22px] shrink-0 border-transparent bg-amber-500/15 px-2 py-0 text-[11px] leading-none text-amber-600 sm:inline-flex dark:text-amber-400"
          >
            {{ getSourceLabel(entry.sessionId) }}
          </Badge>

          <!-- Input preview as badges (hidden on small screens) -->
          <div class="hidden min-w-0 flex-1 items-center gap-1.5 overflow-hidden sm:flex">
            <template v-if="isEntrySkillLoad(entry)">
              <span class="inline-flex h-[22px] shrink-0 items-center gap-1 rounded bg-violet-500/15 px-1.5 font-mono text-[11px] leading-none text-violet-600 dark:text-violet-400">
                <span class="font-medium">{{ getSkillName(entry.input) }}</span>
              </span>
            </template>
            <template v-else>
              <template v-for="(value, key) in parseInputParams(entry.input)" :key="key">
                <span class="inline-flex h-[22px] shrink-0 items-center gap-1 rounded bg-muted px-1.5 font-mono text-[11px] leading-none text-muted-foreground">
                  <span class="font-medium">{{ key }}</span>
                  <span class="max-w-[200px] truncate opacity-70">{{ value }}</span>
                </span>
              </template>
            </template>
          </div>

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
            <!-- Input (hidden if empty or skill load) -->
            <div v-if="hasInputData(expandedDetail.input) && !isEntrySkillLoad(expandedDetail)" class="mb-3">
              <h4 class="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {{ $t('logs.input') }}
              </h4>
              <div class="oa-scrollbar max-h-[200px] overflow-y-auto rounded-md border border-border bg-muted/50 p-3 text-xs leading-snug">
                <ToolDataDisplay :data="parseLogData(expandedDetail.input)" />
              </div>
            </div>

            <!-- Output -->
            <div class="mb-3">
              <h4 class="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {{ $t('logs.output') }}
              </h4>
              <div
                class="oa-scrollbar overflow-y-auto rounded-md border border-border bg-muted/50 p-3 text-xs leading-snug"
                :class="hasMemoryConsolidationDiff(expandedDetail) ? 'max-h-[420px]' : 'max-h-[300px]'"
              >
                <template v-if="isEntrySkillLoad(expandedDetail)">
                  <pre class="whitespace-pre-wrap break-all text-foreground">{{ extractSkillContent(expandedDetail.output) ?? '' }}</pre>
                </template>
                <template v-else-if="hasMemoryConsolidationDiff(expandedDetail)">
                  <MemoryConsolidationDiff :output="expandedDetail.output" />
                </template>
                <template v-else>
                  <ToolDataDisplay :data="parseLogData(expandedDetail.output)" :is-error="expandedDetail.status === 'error'" />
                </template>
              </div>
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

const { isSkillLoad, getSkillName, extractSkillContent } = useSkillDetection()

function isEntrySkillLoad(entry: LogEntry): boolean {
  return isSkillLoad(entry.toolName, entry.input)
}

function entryDisplayName(entry: LogEntry): string {
  return isEntrySkillLoad(entry) ? 'Load Skill' : entry.toolName
}

function isTaskSession(sessionId: string | null | undefined): boolean {
  return !!sessionId && sessionId.startsWith('task-')
}

function getSourceLabel(sessionId: string | null | undefined): string {
  if (isTaskSession(sessionId)) {
    // Extract task name from session_id like "task-abc123"
    return t('logs.sourceTask')
  }
  return t('logs.sourceMainAgent')
}

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

const { t } = useI18n()

const searchQuery = ref('')
const selectedToolName = ref('')
const selectedSourceFilter = ref<'main' | 'task' | ''>('')
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
    sourceFilter: selectedSourceFilter.value || undefined,
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
    sourceFilter: selectedSourceFilter.value || undefined,
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
  if (lower === 'load skill')
    return 'border-transparent bg-violet-500/15 text-violet-600 dark:text-violet-400'
  if (lower === 'session_start')
    return 'border-transparent bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
  if (lower === 'session_end')
    return 'border-transparent bg-sky-500/15 text-sky-600 dark:text-sky-400'
  if (lower === 'session_timeout')
    return 'border-transparent bg-amber-500/15 text-amber-600 dark:text-amber-400'
  if (lower === 'memory_consolidation')
    return 'border-transparent bg-violet-500/15 text-violet-600 dark:text-violet-400'
  if (lower.includes('bash') || lower.includes('exec') || lower.includes('command'))
    return 'border-transparent bg-warning/15 text-warning'
  if (lower.includes('file') || lower.includes('read') || lower.includes('write') || lower.includes('edit'))
    return 'border-transparent bg-blue-500/15 text-blue-500'
  if (lower.includes('llm') || lower.includes('chat') || lower.includes('generate'))
    return 'border-transparent bg-purple-500/15 text-purple-500'
  return 'border-transparent bg-primary/15 text-primary'
}

type MemoryConsolidationLogData = Record<string, unknown> & {
  memoryDiff?: {
    before?: string
    after?: string
  }
}

function isMemoryConsolidationEntry(entry: LogEntry): boolean {
  return entry.toolName.toLowerCase() === 'memory_consolidation'
}

function parseLogData(data: string | null | undefined): unknown {
  if (!data) return null
  try {
    return JSON.parse(data)
  } catch {
    return data
  }
}

function parseMemoryConsolidationOutput(output: string | null | undefined): MemoryConsolidationLogData | null {
  const parsed = parseLogData(output)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  return parsed as MemoryConsolidationLogData
}

function hasMemoryConsolidationDiff(entry: LogEntry): boolean {
  if (!isMemoryConsolidationEntry(entry)) return false
  const parsed = parseMemoryConsolidationOutput(entry.output)
  const diff = parsed?.memoryDiff
  return !!diff && typeof diff.before === 'string' && typeof diff.after === 'string'
}

function parseInputParams(input: string | null | undefined): Record<string, string> {
  if (!input) return {}
  try {
    const parsed = JSON.parse(input)
    return flattenParams(parsed)
  } catch {
    // Input may be truncated by API — try to extract key-value pairs via regex
    return extractParamsFromTruncated(input)
  }
}

function flattenParams(parsed: unknown): Record<string, string> {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const keys = Object.keys(parsed as Record<string, unknown>)
  if (keys.length === 0) return {}
  const result: Record<string, string> = {}
  for (const key of keys) {
    const val = (parsed as Record<string, unknown>)[key]
    const str = val === null ? 'null' : typeof val === 'object' ? JSON.stringify(val) : String(val)
    result[key] = str.length > 80 ? `${str.length} chars` : str
  }
  return result
}

function extractParamsFromTruncated(input: string): Record<string, string> {
  // Match JSON-like key-value pairs from a truncated JSON string
  const result: Record<string, string> = {}
  const keyRegex = /"([^"]+)"\s*:\s*/g
  let match
  while ((match = keyRegex.exec(input)) !== null) {
    const key = match[1]
    const afterColon = input.slice(match.index + match[0].length)
    // Try to determine the value
    if (afterColon.startsWith('"')) {
      // String value — may be truncated
      const endQuote = findUnescapedQuote(afterColon, 1)
      if (endQuote === -1) {
        // Truncated string value
        result[key] = 'truncated'
      } else {
        const val = afterColon.slice(1, endQuote)
        result[key] = val.length > 80 ? `${val.length} chars` : val
      }
    } else {
      // Non-string value (number, bool, null, object, array)
      const valMatch = afterColon.match(/^(true|false|null|-?\d+\.?\d*)/)
      if (valMatch) {
        result[key] = valMatch[1]
      }
    }
  }
  return result
}

function findUnescapedQuote(str: string, start: number): number {
  for (let i = start; i < str.length; i++) {
    if (str[i] === '\\') { i++; continue }
    if (str[i] === '"') return i
  }
  return -1
}

function hasInputData(input: string | null | undefined): boolean {
  if (!input) return false
  try {
    const parsed = JSON.parse(input)
    if (!parsed || typeof parsed !== 'object') return !!input
    return Object.keys(parsed).length > 0
  } catch {
    return !!input.trim()
  }
}

function toolIcon(name: string): string {
  if (!name) return 'wrench'
  const lower = name.toLowerCase()
  if (lower === 'load skill') return 'puzzle'
  if (lower === 'session_start') return 'sparkles'
  if (lower === 'session_end' || lower === 'session_timeout') return 'clock'
  if (lower === 'memory_consolidation') return 'brain'
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
