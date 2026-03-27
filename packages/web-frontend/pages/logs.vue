<template>
  <div class="logs-page">
    <!-- Filter bar -->
    <div class="logs-toolbar">
      <div class="toolbar-left">
        <h2 class="page-title">{{ $t('logs.title') }}</h2>
        <div class="live-controls">
          <button
            class="btn-live"
            :class="{ active: liveMode }"
            @click="toggleLiveMode"
          >
            <span class="live-dot" :class="{ pulsing: liveMode && !paused }" />
            {{ liveMode ? $t('logs.live') : $t('logs.historical') }}
          </button>
          <button
            v-if="liveMode"
            class="btn-pause"
            :class="{ paused }"
            @click="togglePause()"
          >
            {{ paused ? $t('logs.resume') : $t('logs.pause') }}
          </button>
        </div>
      </div>

      <div class="filters">
        <input
          v-model="searchQuery"
          type="text"
          class="filter-input search-input"
          :placeholder="$t('logs.searchPlaceholder')"
          @input="debouncedSearch"
        />

        <select v-model="selectedToolName" class="filter-input" @change="applyFilters">
          <option value="">{{ $t('logs.allTools') }}</option>
          <option v-for="name in toolNames" :key="name" :value="name">
            {{ name }}
          </option>
        </select>

        <input
          v-model="dateFrom"
          type="date"
          class="filter-input date-input"
          :placeholder="$t('logs.dateFrom')"
          @change="applyFilters"
        />
        <input
          v-model="dateTo"
          type="date"
          class="filter-input date-input"
          :placeholder="$t('logs.dateTo')"
          @change="applyFilters"
        />
      </div>
    </div>

    <!-- Loading state -->
    <div v-if="loading && logs.length === 0" class="logs-empty">
      <p>{{ $t('logs.loading') }}</p>
    </div>

    <!-- Empty state -->
    <div v-else-if="!loading && logs.length === 0" class="logs-empty">
      <span class="empty-icon">📋</span>
      <p>{{ $t('logs.noEntries') }}</p>
    </div>

    <!-- Log entries -->
    <div v-else class="logs-list" ref="logsListRef">
      <div
        v-for="entry in logs"
        :key="entry.id"
        class="log-entry"
        :class="{ error: entry.status === 'error', expanded: expandedId === entry.id }"
        @click="toggleExpand(entry.id)"
      >
        <div class="log-row">
          <span class="log-timestamp">{{ formatTimestamp(entry.timestamp) }}</span>
          <span class="log-tool" :class="toolClass(entry.toolName)">
            <span class="tool-icon">{{ toolIcon(entry.toolName) }}</span>
            {{ entry.toolName }}
          </span>
          <span class="log-input-preview">{{ entry.input || '—' }}</span>
          <span class="log-duration">{{ formatDuration(entry.durationMs) }}</span>
          <span class="log-status" :class="entry.status">
            {{ entry.status === 'success' ? '✓' : '✗' }}
          </span>
          <span class="log-expand-icon">{{ expandedId === entry.id ? '▾' : '▸' }}</span>
        </div>

        <!-- Expanded detail -->
        <div v-if="expandedId === entry.id" class="log-detail">
          <div v-if="detailLoading" class="detail-loading">{{ $t('logs.loading') }}</div>
          <template v-else-if="expandedDetail">
            <div class="detail-section">
              <h4>{{ $t('logs.input') }}</h4>
              <pre class="detail-code">{{ expandedDetail.input || '—' }}</pre>
            </div>
            <div class="detail-section">
              <h4>{{ $t('logs.output') }}</h4>
              <pre class="detail-code">{{ expandedDetail.output || '—' }}</pre>
            </div>
            <div class="detail-meta">
              <span>{{ $t('logs.sessionId') }}: {{ expandedDetail.sessionId }}</span>
              <span>{{ $t('logs.duration') }}: {{ formatDuration(expandedDetail.durationMs) }}</span>
              <span>{{ $t('logs.status') }}: {{ expandedDetail.status }}</span>
            </div>
          </template>
        </div>
      </div>
    </div>

    <!-- Pagination (historical mode) -->
    <div v-if="!liveMode && pagination.totalPages > 1" class="pagination">
      <button
        class="pagination-btn"
        :disabled="pagination.page <= 1"
        @click="goToPage(pagination.page - 1)"
      >
        ← {{ $t('logs.prev') }}
      </button>
      <span class="pagination-info">
        {{ $t('logs.pageInfo', { page: pagination.page, total: pagination.totalPages }) }}
      </span>
      <button
        class="pagination-btn"
        :disabled="pagination.page >= pagination.totalPages"
        @click="goToPage(pagination.page + 1)"
      >
        {{ $t('logs.next') }} →
      </button>
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
    // In live mode, switch to historical for filtering
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
    fetchLogs() // Load initial entries
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

function toolClass(name: string): string {
  if (!name) return 'tool-default'
  const lower = name.toLowerCase()
  if (lower.includes('bash') || lower.includes('exec') || lower.includes('command')) return 'tool-bash'
  if (lower.includes('file') || lower.includes('read') || lower.includes('write') || lower.includes('edit')) return 'tool-file'
  if (lower.includes('llm') || lower.includes('chat') || lower.includes('generate')) return 'tool-llm'
  return 'tool-default'
}

function toolIcon(name: string): string {
  if (!name) return '🔧'
  const lower = name.toLowerCase()
  if (lower.includes('bash') || lower.includes('exec') || lower.includes('command')) return '⚡'
  if (lower.includes('file') || lower.includes('read') || lower.includes('write') || lower.includes('edit')) return '📄'
  if (lower.includes('llm') || lower.includes('chat') || lower.includes('generate')) return '🧠'
  return '🔧'
}

// Initialize
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

<style scoped>
.logs-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

/* Toolbar */
.logs-toolbar {
  padding: 16px 20px;
  border-bottom: 1px solid var(--color-border);
  display: flex;
  flex-direction: column;
  gap: 12px;
  flex-shrink: 0;
}

.toolbar-left {
  display: flex;
  align-items: center;
  gap: 16px;
}

.page-title {
  font-size: 18px;
  font-weight: 600;
  color: var(--color-text);
  margin: 0;
}

.live-controls {
  display: flex;
  gap: 8px;
}

.btn-live {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: 6px;
  border: 1px solid var(--color-border);
  background: var(--color-bg-tertiary);
  color: var(--color-text-secondary);
  font-size: 13px;
  font-weight: 500;
  transition: all 0.15s ease;
}

.btn-live.active {
  border-color: var(--color-success);
  color: var(--color-success);
  background: rgba(34, 197, 94, 0.1);
}

.live-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-text-muted);
}

.btn-live.active .live-dot {
  background: var(--color-success);
}

.live-dot.pulsing {
  animation: pulse 1.5s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

.btn-pause {
  padding: 6px 12px;
  border-radius: 6px;
  border: 1px solid var(--color-border);
  background: var(--color-bg-tertiary);
  color: var(--color-text-secondary);
  font-size: 13px;
  font-weight: 500;
  transition: all 0.15s ease;
}

.btn-pause.paused {
  border-color: var(--color-warning);
  color: var(--color-warning);
  background: rgba(245, 158, 11, 0.1);
}

/* Filters */
.filters {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.filter-input {
  padding: 7px 12px;
  border-radius: 6px;
  border: 1px solid var(--color-border);
  background: var(--color-bg-tertiary);
  color: var(--color-text);
  font-size: 13px;
  font-family: inherit;
  outline: none;
  transition: border-color 0.15s ease;
}

.filter-input:focus {
  border-color: var(--color-primary);
}

.search-input {
  flex: 1;
  min-width: 200px;
}

.date-input {
  width: 140px;
}

select.filter-input {
  min-width: 140px;
  cursor: pointer;
}

/* Empty state */
.logs-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: var(--color-text-muted);
  gap: 12px;
}

.empty-icon {
  font-size: 48px;
  opacity: 0.5;
}

/* Log list */
.logs-list {
  flex: 1;
  overflow-y: auto;
  padding: 0;
}

/* Log entry */
.log-entry {
  border-bottom: 1px solid var(--color-border);
  cursor: pointer;
  transition: background 0.1s ease;
}

.log-entry:hover {
  background: var(--color-bg-tertiary);
}

.log-entry.error {
  border-left: 3px solid var(--color-danger);
}

.log-entry.expanded {
  background: var(--color-bg-secondary);
}

.log-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 20px;
  font-size: 13px;
}

.log-timestamp {
  color: var(--color-text-muted);
  font-size: 12px;
  white-space: nowrap;
  min-width: 130px;
  font-variant-numeric: tabular-nums;
}

.log-tool {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
  min-width: 100px;
}

.tool-icon {
  font-size: 12px;
}

.tool-bash {
  background: rgba(245, 158, 11, 0.15);
  color: #f59e0b;
}

.tool-file {
  background: rgba(59, 130, 246, 0.15);
  color: #3b82f6;
}

.tool-llm {
  background: rgba(168, 85, 247, 0.15);
  color: #a855f7;
}

.tool-default {
  background: rgba(99, 102, 241, 0.15);
  color: #6366f1;
}

.log-input-preview {
  flex: 1;
  color: var(--color-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 12px;
  min-width: 0;
}

.log-duration {
  color: var(--color-text-muted);
  font-size: 12px;
  white-space: nowrap;
  min-width: 60px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.log-status {
  font-size: 14px;
  width: 20px;
  text-align: center;
}

.log-status.success {
  color: var(--color-success);
}

.log-status.error {
  color: var(--color-danger);
}

.log-expand-icon {
  color: var(--color-text-muted);
  font-size: 11px;
  width: 16px;
  text-align: center;
}

/* Detail panel */
.log-detail {
  padding: 12px 20px 16px 20px;
  border-top: 1px solid var(--color-border);
  background: var(--color-bg);
}

.detail-loading {
  color: var(--color-text-muted);
  font-size: 13px;
  padding: 8px 0;
}

.detail-section {
  margin-bottom: 12px;
}

.detail-section h4 {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 6px;
}

.detail-code {
  background: var(--color-bg-tertiary);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  padding: 10px 12px;
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 12px;
  line-height: 1.5;
  color: var(--color-text);
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 300px;
  overflow-y: auto;
}

.detail-meta {
  display: flex;
  gap: 20px;
  font-size: 12px;
  color: var(--color-text-muted);
  flex-wrap: wrap;
}

/* Pagination */
.pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 16px;
  padding: 12px 20px;
  border-top: 1px solid var(--color-border);
  flex-shrink: 0;
}

.pagination-btn {
  padding: 6px 14px;
  border-radius: 6px;
  border: 1px solid var(--color-border);
  background: var(--color-bg-tertiary);
  color: var(--color-text-secondary);
  font-size: 13px;
  transition: all 0.15s ease;
}

.pagination-btn:hover:not(:disabled) {
  background: var(--color-bg-secondary);
  color: var(--color-text);
}

.pagination-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.pagination-info {
  font-size: 13px;
  color: var(--color-text-muted);
}

/* Mobile responsive */
@media (max-width: 768px) {
  .toolbar-left {
    flex-wrap: wrap;
  }

  .filters {
    flex-direction: column;
  }

  .filter-input {
    width: 100% !important;
    min-width: unset !important;
  }

  .log-row {
    padding: 8px 12px;
    gap: 8px;
    flex-wrap: wrap;
  }

  .log-timestamp {
    min-width: unset;
  }

  .log-input-preview {
    display: none;
  }

  .log-duration {
    min-width: unset;
  }

  .detail-meta {
    flex-direction: column;
    gap: 4px;
  }
}
</style>
