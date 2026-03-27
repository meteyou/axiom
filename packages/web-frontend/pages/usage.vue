<template>
  <div v-if="!isAdmin" class="admin-gate">
    <span class="gate-icon">🔒</span>
    <h1>{{ $t('admin.title') }}</h1>
    <p>{{ $t('admin.description') }}</p>
  </div>

  <div v-else class="usage-page">
    <div class="usage-header">
      <div>
        <p class="eyebrow">{{ $t('usage.kicker') }}</p>
        <h1>{{ $t('usage.title') }}</h1>
        <p class="usage-subtitle">{{ $t('usage.subtitle') }}</p>
      </div>
      <button class="btn btn-outline" :disabled="loading" @click="loadUsage">{{ $t('usage.refresh') }}</button>
    </div>

    <div v-if="error" class="error-banner">
      {{ error }}
      <button class="error-dismiss" @click="error = null">✕</button>
    </div>

    <div v-if="loading" class="loading-state">{{ $t('usage.loading') }}</div>

    <template v-else>
      <section class="summary-grid">
        <article class="summary-card glass">
          <span class="summary-label">{{ $t('usage.summary.requests') }}</span>
          <strong class="summary-value">{{ formatNumber(data.summary.requests) }}</strong>
        </article>
        <article class="summary-card glass">
          <span class="summary-label">{{ $t('usage.summary.totalTokens') }}</span>
          <strong class="summary-value">{{ formatNumber(data.summary.totalTokens) }}</strong>
        </article>
        <article class="summary-card glass">
          <span class="summary-label">{{ $t('usage.summary.promptTokens') }}</span>
          <strong class="summary-value">{{ formatNumber(data.summary.promptTokens) }}</strong>
        </article>
        <article class="summary-card glass">
          <span class="summary-label">{{ $t('usage.summary.completionTokens') }}</span>
          <strong class="summary-value">{{ formatNumber(data.summary.completionTokens) }}</strong>
        </article>
        <article class="summary-card glass emphasis">
          <span class="summary-label">{{ $t('usage.summary.estimatedCost') }}</span>
          <strong class="summary-value">{{ formatCurrency(data.summary.estimatedCost) }}</strong>
        </article>
      </section>

      <section class="usage-grid">
        <article class="panel glass">
          <div class="panel-head">
            <h2>{{ $t('usage.byProvider') }}</h2>
            <p>{{ $t('usage.byProviderDescription') }}</p>
          </div>

          <table class="data-table">
            <thead>
              <tr>
                <th>{{ $t('usage.columns.provider') }}</th>
                <th>{{ $t('usage.columns.requests') }}</th>
                <th>{{ $t('usage.columns.tokens') }}</th>
                <th>{{ $t('usage.columns.cost') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="data.byProvider.length === 0">
                <td colspan="4" class="empty-row">{{ $t('usage.empty') }}</td>
              </tr>
              <tr v-for="entry in data.byProvider" :key="entry.provider">
                <td>{{ entry.provider }}</td>
                <td>{{ formatNumber(entry.requests) }}</td>
                <td>{{ formatNumber(entry.totalTokens) }}</td>
                <td>{{ formatCurrency(entry.estimatedCost) }}</td>
              </tr>
            </tbody>
          </table>
        </article>

        <article class="panel glass">
          <div class="panel-head">
            <h2>{{ $t('usage.byModel') }}</h2>
            <p>{{ $t('usage.byModelDescription') }}</p>
          </div>

          <table class="data-table">
            <thead>
              <tr>
                <th>{{ $t('usage.columns.model') }}</th>
                <th>{{ $t('usage.columns.requests') }}</th>
                <th>{{ $t('usage.columns.tokens') }}</th>
                <th>{{ $t('usage.columns.cost') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="data.byModel.length === 0">
                <td colspan="4" class="empty-row">{{ $t('usage.empty') }}</td>
              </tr>
              <tr v-for="entry in data.byModel" :key="entry.model">
                <td>{{ entry.model }}</td>
                <td>{{ formatNumber(entry.requests) }}</td>
                <td>{{ formatNumber(entry.totalTokens) }}</td>
                <td>{{ formatCurrency(entry.estimatedCost) }}</td>
              </tr>
            </tbody>
          </table>
        </article>
      </section>

      <section class="panel glass recent-panel">
        <div class="panel-head">
          <h2>{{ $t('usage.recentRequests') }}</h2>
          <p>{{ $t('usage.recentRequestsDescription') }}</p>
        </div>

        <table class="data-table recent-table">
          <thead>
            <tr>
              <th>{{ $t('usage.columns.timestamp') }}</th>
              <th>{{ $t('usage.columns.provider') }}</th>
              <th>{{ $t('usage.columns.model') }}</th>
              <th>{{ $t('usage.columns.session') }}</th>
              <th>{{ $t('usage.columns.tokens') }}</th>
              <th>{{ $t('usage.columns.cost') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="data.recent.length === 0">
              <td colspan="6" class="empty-row">{{ $t('usage.empty') }}</td>
            </tr>
            <tr v-for="entry in data.recent" :key="entry.id">
              <td>{{ formatDate(entry.timestamp) }}</td>
              <td>{{ entry.provider }}</td>
              <td>{{ entry.model }}</td>
              <td class="mono">{{ entry.sessionId || '—' }}</td>
              <td>{{ formatNumber(entry.promptTokens + entry.completionTokens) }}</td>
              <td>{{ formatCurrency(entry.estimatedCost) }}</td>
            </tr>
          </tbody>
        </table>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
interface UsageResponse {
  summary: {
    requests: number
    promptTokens: number
    completionTokens: number
    totalTokens: number
    estimatedCost: number
  }
  byProvider: Array<{
    provider: string
    requests: number
    promptTokens: number
    completionTokens: number
    totalTokens: number
    estimatedCost: number
  }>
  byModel: Array<{
    model: string
    requests: number
    promptTokens: number
    completionTokens: number
    totalTokens: number
    estimatedCost: number
  }>
  recent: Array<{
    id: number
    timestamp: string
    provider: string
    model: string
    promptTokens: number
    completionTokens: number
    estimatedCost: number
    sessionId: string | null
  }>
}

const { apiFetch } = useApi()
const { user } = useAuth()
const isAdmin = computed(() => user.value?.role === 'admin')

const loading = ref(false)
const error = ref<string | null>(null)
const data = ref<UsageResponse>({
  summary: {
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    estimatedCost: 0,
  },
  byProvider: [],
  byModel: [],
  recent: [],
})

onMounted(async () => {
  if (!isAdmin.value) return
  await loadUsage()
})

async function loadUsage() {
  loading.value = true
  error.value = null
  try {
    data.value = await apiFetch<UsageResponse>('/api/usage')
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    loading.value = false
  }
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value)
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(value)
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}
</script>

<style scoped>
.usage-page {
  padding: 24px;
  max-width: 1200px;
  margin: 0 auto;
  height: 100%;
  overflow-y: auto;
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

.usage-header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 20px;
}

.eyebrow {
  font-size: 12px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: #a5b4fc;
  margin-bottom: 8px;
}

.usage-header h1 {
  font-size: 28px;
}

.usage-subtitle {
  margin-top: 8px;
  color: var(--color-text-secondary);
}

.glass {
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.03), rgba(255, 255, 255, 0.01)),
    var(--color-bg-secondary);
  border: 1px solid rgba(255, 255, 255, 0.06);
  box-shadow: 0 14px 30px rgba(0, 0, 0, 0.16);
}

.error-banner {
  padding: 12px 16px;
  border-radius: 12px;
  margin-bottom: 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 14px;
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid var(--color-error, #ef4444);
  color: var(--color-error, #ef4444);
}

.error-dismiss {
  background: none;
  border: none;
  color: inherit;
}

.loading-state {
  display: grid;
  place-items: center;
  padding: 100px 20px;
  color: var(--color-text-muted);
}

.summary-grid {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 14px;
  margin-bottom: 18px;
}

.summary-card {
  border-radius: 18px;
  padding: 18px;
}

.summary-card.emphasis {
  background:
    linear-gradient(135deg, rgba(99, 102, 241, 0.18), rgba(139, 92, 246, 0.12)),
    var(--color-bg-secondary);
}

.summary-label {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--color-text-muted);
}

.summary-value {
  display: block;
  margin-top: 12px;
  font-size: 28px;
}

.usage-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  margin-bottom: 16px;
}

.panel {
  border-radius: 20px;
  padding: 22px;
}

.panel-head h2 {
  font-size: 18px;
}

.panel-head p {
  margin-top: 6px;
  font-size: 13px;
  color: var(--color-text-muted);
}

.data-table {
  width: 100%;
  border-collapse: collapse;
  margin-top: 18px;
}

.data-table th,
.data-table td {
  padding: 12px 10px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  text-align: left;
  font-size: 13px;
}

.data-table th {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--color-text-muted);
}

.empty-row {
  text-align: center !important;
  color: var(--color-text-muted);
  padding: 24px !important;
}

.recent-panel {
  margin-bottom: 18px;
}

.mono {
  font-family: 'SF Mono', 'Fira Code', monospace;
}

.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 10px 16px;
  border-radius: 10px;
  font-size: 14px;
  font-weight: 600;
  border: 1px solid var(--color-border);
  background: transparent;
  color: var(--color-text-secondary);
}

.btn:hover:not(:disabled) {
  background: var(--color-bg-tertiary);
  color: var(--color-text);
}

@media (max-width: 1024px) {
  .usage-page {
    padding: 16px;
  }

  .summary-grid,
  .usage-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .usage-header {
    flex-direction: column;
    align-items: flex-start;
  }

  .panel {
    overflow-x: auto;
  }
}
</style>
