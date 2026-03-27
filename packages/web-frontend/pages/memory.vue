<template>
  <div v-if="!isAdmin" class="admin-gate">
    <span class="gate-icon">🔒</span>
    <h1>{{ $t('admin.title') }}</h1>
    <p>{{ $t('admin.description') }}</p>
  </div>

  <div v-else class="memory-page">
    <div class="memory-header">
      <div>
        <p class="eyebrow">{{ $t('memory.kicker') }}</p>
        <h1>{{ $t('memory.title') }}</h1>
        <p class="memory-subtitle">{{ $t('memory.subtitle') }}</p>
      </div>
    </div>

    <div v-if="error" class="error-banner">
      {{ error }}
      <button class="error-dismiss" @click="clearMessages()">✕</button>
    </div>
    <div v-if="successMessage" class="success-banner">
      {{ $t('memory.saveSuccess') }}
      <button class="success-dismiss" @click="clearMessages()">✕</button>
    </div>

    <div class="tabs">
      <button class="tab" :class="{ active: activeTab === 'soul' }" @click="switchTab('soul')">
        {{ $t('memory.soulTab') }}
      </button>
      <button class="tab" :class="{ active: activeTab === 'agents' }" @click="switchTab('agents')">
        {{ $t('memory.agentsTab') }}
      </button>
      <button class="tab" :class="{ active: activeTab === 'daily' }" @click="switchTab('daily')">
        {{ $t('memory.dailyTab') }}
      </button>
    </div>

    <div v-if="activeTab === 'soul'" class="tab-content">
      <div v-if="loading" class="loading-state">{{ $t('memory.loading') }}</div>
      <div v-else class="editor-container">
        <div class="editor-toolbar">
          <button class="btn btn-sm btn-outline" :class="{ active: previewMode === 'edit' }" @click="previewMode = 'edit'">{{ $t('memory.edit') }}</button>
          <button class="btn btn-sm btn-outline" :class="{ active: previewMode === 'preview' }" @click="previewMode = 'preview'">{{ $t('memory.preview') }}</button>
          <button class="btn btn-sm btn-outline" :class="{ active: previewMode === 'split' }" @click="previewMode = 'split'">{{ $t('memory.split') }}</button>
        </div>

        <div class="editor-area" :class="previewMode">
          <textarea
            v-if="previewMode !== 'preview'"
            v-model="soulContent"
            class="md-editor"
            :placeholder="$t('memory.editorPlaceholder')"
            spellcheck="false"
          />
          <div v-if="previewMode !== 'edit'" class="md-preview" v-html="renderMarkdown(soulContent)" />
        </div>

        <div class="editor-footer">
          <button class="btn btn-primary" :disabled="saving" @click="handleSaveSoul">
            <span v-if="saving" class="spinner" />
            {{ $t('memory.save') }}
          </button>
        </div>
      </div>
    </div>

    <div v-if="activeTab === 'agents'" class="tab-content">
      <div v-if="loading" class="loading-state">{{ $t('memory.loading') }}</div>
      <div v-else class="editor-container">
        <div class="editor-toolbar">
          <button class="btn btn-sm btn-outline" :class="{ active: previewMode === 'edit' }" @click="previewMode = 'edit'">{{ $t('memory.edit') }}</button>
          <button class="btn btn-sm btn-outline" :class="{ active: previewMode === 'preview' }" @click="previewMode = 'preview'">{{ $t('memory.preview') }}</button>
          <button class="btn btn-sm btn-outline" :class="{ active: previewMode === 'split' }" @click="previewMode = 'split'">{{ $t('memory.split') }}</button>
        </div>

        <div class="editor-area" :class="previewMode">
          <textarea
            v-if="previewMode !== 'preview'"
            v-model="agentsContent"
            class="md-editor"
            :placeholder="$t('memory.editorPlaceholder')"
            spellcheck="false"
          />
          <div v-if="previewMode !== 'edit'" class="md-preview" v-html="renderMarkdown(agentsContent)" />
        </div>

        <div class="editor-footer">
          <button class="btn btn-primary" :disabled="saving" @click="handleSaveAgents">
            <span v-if="saving" class="spinner" />
            {{ $t('memory.save') }}
          </button>
        </div>
      </div>
    </div>

    <div v-if="activeTab === 'daily'" class="tab-content">
      <div v-if="!selectedDaily" class="daily-list-view">
        <div class="daily-toolbar glass">
          <div class="daily-toolbar-copy">
            <h2>{{ $t('memory.dailyBrowserTitle') }}</h2>
            <p>{{ $t('memory.dailyBrowserDescription') }}</p>
          </div>
          <div class="daily-picker">
            <input v-model="dailyDateInput" type="date" class="date-input" />
            <button class="btn btn-outline" @click="openDailyDate">{{ $t('memory.openDate') }}</button>
          </div>
        </div>

        <div v-if="loading" class="loading-state">{{ $t('memory.loading') }}</div>
        <div v-else-if="dailyFiles.length === 0" class="empty-state">
          <span class="empty-icon">📅</span>
          <p>{{ $t('memory.noDailyFiles') }}</p>
        </div>
        <div v-else class="daily-list">
          <div v-for="file in dailyFiles" :key="file.date" class="daily-item" @click="openDailyFile(file.date)">
            <div>
              <span class="daily-date">{{ file.date }}</span>
              <span class="daily-meta">{{ $t('memory.lastUpdated', { date: formatDate(file.modifiedAt) }) }}</span>
            </div>
            <span class="daily-size">{{ formatSize(file.size) }}</span>
          </div>
        </div>
      </div>

      <div v-else class="daily-editor-view">
        <div class="daily-editor-header">
          <button class="btn btn-sm btn-outline" @click="closeDailyFile">← {{ $t('memory.backToList') }}</button>
          <div>
            <span class="daily-date-label">{{ selectedDaily }}</span>
            <p class="daily-editor-subtitle">{{ $t('memory.dailyEditorDescription') }}</p>
          </div>
        </div>

        <div v-if="loading" class="loading-state">{{ $t('memory.loading') }}</div>
        <div v-else class="editor-container">
          <div class="editor-toolbar">
            <button class="btn btn-sm btn-outline" :class="{ active: previewMode === 'edit' }" @click="previewMode = 'edit'">{{ $t('memory.edit') }}</button>
            <button class="btn btn-sm btn-outline" :class="{ active: previewMode === 'preview' }" @click="previewMode = 'preview'">{{ $t('memory.preview') }}</button>
            <button class="btn btn-sm btn-outline" :class="{ active: previewMode === 'split' }" @click="previewMode = 'split'">{{ $t('memory.split') }}</button>
          </div>

          <div class="editor-area" :class="previewMode">
            <textarea
              v-if="previewMode !== 'preview'"
              v-model="dailyContent"
              class="md-editor"
              :placeholder="$t('memory.editorPlaceholder')"
              spellcheck="false"
            />
            <div v-if="previewMode !== 'edit'" class="md-preview" v-html="renderMarkdown(dailyContent)" />
          </div>

          <div class="editor-footer">
            <button class="btn btn-primary" :disabled="saving" @click="handleSaveDaily">
              <span v-if="saving" class="spinner" />
              {{ $t('memory.save') }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
const { user } = useAuth()
const isAdmin = computed(() => user.value?.role === 'admin')

const {
  loading,
  saving,
  error,
  successMessage,
  loadSoul,
  saveSoul,
  loadAgents,
  saveAgents,
  loadDailyFiles,
  loadDailyFile,
  saveDailyFile,
  clearMessages,
} = useMemory()

const activeTab = ref<'soul' | 'agents' | 'daily'>('soul')
const previewMode = ref<'edit' | 'preview' | 'split'>('split')

const soulContent = ref('')
const agentsContent = ref('')
const dailyContent = ref('')
const dailyFiles = ref<{ filename: string; date: string; size: number; modifiedAt: string }[]>([])
const selectedDaily = ref<string | null>(null)
const dailyDateInput = ref(new Date().toISOString().slice(0, 10))

function renderMarkdown(text: string): string {
  if (!text) return ''
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>)/gs, '<ul>$1</ul>')
    .replace(/\n{2,}/g, '<br/><br/>')
    .replace(/\n/g, '<br/>')
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(1)} KB`
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

async function switchTab(tab: 'soul' | 'agents' | 'daily') {
  clearMessages()
  activeTab.value = tab
  previewMode.value = tab === 'daily' ? 'split' : 'split'

  if (tab === 'soul' && !soulContent.value) {
    soulContent.value = await loadSoul()
  } else if (tab === 'agents' && !agentsContent.value) {
    agentsContent.value = await loadAgents()
  } else if (tab === 'daily') {
    await refreshDailyFiles()
  }
}

async function refreshDailyFiles() {
  selectedDaily.value = null
  dailyFiles.value = await loadDailyFiles()
}

async function handleSaveSoul() {
  await saveSoul(soulContent.value)
  autoHideSuccess()
}

async function handleSaveAgents() {
  await saveAgents(agentsContent.value)
  autoHideSuccess()
}

async function handleSaveDaily() {
  if (!selectedDaily.value) return
  const saved = await saveDailyFile(selectedDaily.value, dailyContent.value)
  if (saved) {
    await refreshDailyFiles()
    selectedDaily.value = dailyDateInput.value
    dailyContent.value = await loadDailyFile(dailyDateInput.value)
  }
  autoHideSuccess()
}

async function openDailyFile(date: string) {
  clearMessages()
  selectedDaily.value = date
  dailyDateInput.value = date
  const content = await loadDailyFile(date)
  if (error.value?.includes('not found')) {
    clearMessages()
    dailyContent.value = `# Daily Memory — ${date}\n\n`
    return
  }
  dailyContent.value = content || `# Daily Memory — ${date}\n\n`
}

async function openDailyDate() {
  if (!dailyDateInput.value) return
  await openDailyFile(dailyDateInput.value)
}

function closeDailyFile() {
  selectedDaily.value = null
  dailyContent.value = ''
  clearMessages()
}

function autoHideSuccess() {
  setTimeout(() => {
    successMessage.value = null
  }, 3000)
}

onMounted(async () => {
  if (!isAdmin.value) return
  soulContent.value = await loadSoul()
})
</script>

<style scoped>
.memory-page {
  padding: 24px;
  max-width: 1100px;
  margin: 0 auto;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.admin-gate {
  display: grid;
  place-items: center;
  gap: 10px;
  padding: 40px;
  height: 100%;
  color: var(--color-text-muted);
  text-align: center;
}

.gate-icon {
  font-size: 44px;
}

.memory-header {
  margin-bottom: 16px;
  flex-shrink: 0;
}

.eyebrow {
  font-size: 12px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: #a5b4fc;
  margin-bottom: 8px;
}

.memory-header h1 {
  font-size: 28px;
  font-weight: 700;
  color: var(--color-text);
  margin: 0;
}

.memory-subtitle {
  margin-top: 8px;
  color: var(--color-text-secondary);
}

.error-banner,
.success-banner {
  padding: 12px 16px;
  border-radius: 12px;
  margin-bottom: 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 14px;
  flex-shrink: 0;
}

.error-banner {
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid var(--color-error, #ef4444);
  color: var(--color-error, #ef4444);
}

.success-banner {
  background: rgba(34, 197, 94, 0.1);
  border: 1px solid rgba(34, 197, 94, 0.25);
  color: #4ade80;
}

.error-dismiss,
.success-dismiss {
  background: none;
  border: none;
  color: inherit;
  font-size: 16px;
}

.tabs {
  display: flex;
  gap: 6px;
  margin-bottom: 18px;
  flex-shrink: 0;
}

.tab {
  padding: 10px 18px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 999px;
  color: var(--color-text-secondary);
  font-size: 14px;
  font-weight: 600;
  transition: all 0.15s ease;
}

.tab:hover {
  color: var(--color-text);
}

.tab.active {
  color: #c7d2fe;
  background: rgba(99, 102, 241, 0.16);
  border-color: rgba(129, 140, 248, 0.22);
}

.tab-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-height: 0;
}

.loading-state,
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 60px 20px;
  color: var(--color-text-muted);
  gap: 16px;
}

.empty-icon {
  font-size: 48px;
  opacity: 0.5;
}

.glass {
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.03), rgba(255, 255, 255, 0.01)),
    var(--color-bg-secondary);
  border: 1px solid rgba(255, 255, 255, 0.06);
}

.editor-container {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-height: 0;
}

.editor-toolbar {
  display: flex;
  gap: 6px;
  margin-bottom: 10px;
  flex-shrink: 0;
}

.editor-area {
  flex: 1;
  display: flex;
  gap: 12px;
  overflow: hidden;
  min-height: 0;
}

.editor-area.edit .md-editor { width: 100%; }
.editor-area.preview .md-preview { width: 100%; }
.editor-area.split .md-editor,
.editor-area.split .md-preview { width: 50%; }

.md-editor,
.md-preview {
  background: rgba(15, 17, 23, 0.76);
  border: 1px solid var(--color-border);
  border-radius: 16px;
  padding: 18px;
  color: var(--color-text);
  font-size: 14px;
  line-height: 1.7;
  overflow-y: auto;
}

.md-editor {
  font-family: 'SF Mono', 'Fira Code', monospace;
  resize: none;
  outline: none;
}

.md-editor:focus {
  border-color: var(--color-primary);
}

.md-preview :deep(h1) { font-size: 22px; font-weight: 700; margin: 12px 0 8px; }
.md-preview :deep(h2) { font-size: 18px; font-weight: 600; margin: 10px 0 6px; }
.md-preview :deep(h3) { font-size: 16px; font-weight: 600; margin: 8px 0 4px; }
.md-preview :deep(code) {
  background: var(--color-bg-tertiary);
  padding: 2px 6px;
  border-radius: 4px;
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 13px;
}
.md-preview :deep(ul) { padding-left: 20px; margin: 4px 0; }
.md-preview :deep(li) { margin: 2px 0; }

.editor-footer {
  display: flex;
  justify-content: flex-end;
  padding-top: 12px;
}

.daily-list-view {
  flex: 1;
  overflow-y: auto;
}

.daily-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  border-radius: 16px;
  padding: 18px;
  margin-bottom: 16px;
}

.daily-toolbar-copy h2 {
  font-size: 16px;
  color: var(--color-text);
}

.daily-toolbar-copy p {
  margin-top: 6px;
  font-size: 13px;
  color: var(--color-text-muted);
}

.daily-picker {
  display: flex;
  gap: 10px;
  align-items: center;
}

.date-input {
  padding: 10px 12px;
  background: rgba(15, 17, 23, 0.76);
  border: 1px solid var(--color-border);
  border-radius: 10px;
  color: var(--color-text);
}

.daily-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.daily-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: 14px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.daily-item:hover {
  border-color: rgba(129, 140, 248, 0.3);
  transform: translateY(-1px);
}

.daily-date {
  display: block;
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text);
}

.daily-meta,
.daily-size,
.daily-editor-subtitle {
  font-size: 12px;
  color: var(--color-text-muted);
}

.daily-editor-view {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-height: 0;
}

.daily-editor-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
  flex-shrink: 0;
}

.daily-date-label {
  display: block;
  font-size: 18px;
  font-weight: 700;
  color: var(--color-text);
}

.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 9px 16px;
  border-radius: 10px;
  font-size: 14px;
  font-weight: 600;
  border: none;
  transition: all 0.15s ease;
}

.btn:disabled { opacity: 0.5; cursor: not-allowed; }

.btn-primary {
  background: linear-gradient(135deg, var(--color-primary), #8b5cf6);
  color: white;
}

.btn-outline {
  background: transparent;
  border: 1px solid var(--color-border);
  color: var(--color-text-secondary);
}

.btn-outline:hover:not(:disabled) {
  background: var(--color-bg-tertiary);
  color: var(--color-text);
}

.btn-outline.active {
  background: rgba(99, 102, 241, 0.12);
  color: #c7d2fe;
  border-color: rgba(129, 140, 248, 0.2);
}

.btn-sm { padding: 6px 10px; font-size: 13px; }

.spinner {
  width: 14px;
  height: 14px;
  border: 2px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}

@keyframes spin { to { transform: rotate(360deg); } }

@media (max-width: 768px) {
  .memory-page { padding: 16px; }
  .daily-toolbar,
  .daily-editor-header,
  .daily-picker {
    flex-direction: column;
    align-items: stretch;
  }
  .editor-area.split { flex-direction: column; }
  .editor-area.split .md-editor,
  .editor-area.split .md-preview { width: 100%; height: 50%; }
}
</style>
