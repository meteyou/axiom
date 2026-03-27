<template>
  <div v-if="!isAdmin" class="admin-gate">
    <span class="gate-icon">🔒</span>
    <h1>{{ $t('admin.title') }}</h1>
    <p>{{ $t('admin.description') }}</p>
  </div>

  <div v-else class="dashboard-page">
    <div class="dashboard-hero glass">
      <div>
        <p class="eyebrow">{{ $t('dashboard.kicker') }}</p>
        <h1>{{ $t('dashboard.title') }}</h1>
        <p class="dashboard-subtitle">{{ $t('dashboard.subtitle') }}</p>
      </div>
      <button class="btn btn-outline" :disabled="loading" @click="loadDashboard">{{ $t('dashboard.refresh') }}</button>
    </div>

    <div v-if="error" class="error-banner">
      {{ error }}
      <button class="error-dismiss" @click="error = null">✕</button>
    </div>

    <div v-if="loading" class="loading-state">{{ $t('dashboard.loading') }}</div>

    <template v-else>
      <section class="stats-grid">
        <article class="stat-card glass" v-for="card in statCards" :key="card.label">
          <span class="stat-label">{{ card.label }}</span>
          <strong class="stat-value">{{ card.value }}</strong>
          <span class="stat-meta">{{ card.meta }}</span>
        </article>
      </section>

      <section class="status-grid">
        <article class="panel glass provider-panel">
          <div class="panel-head">
            <div>
              <p class="panel-kicker">{{ $t('dashboard.providerHealth') }}</p>
              <h2>{{ providerName }}</h2>
              <p>{{ providerModel }}</p>
            </div>
            <span class="status-badge" :class="statusBadgeClass(providerStatus)">
              {{ providerStatusLabel }}
            </span>
          </div>

          <div class="provider-summary">
            <div class="signal-ring" :class="statusBadgeClass(providerStatus)">
              <span />
            </div>

            <div class="provider-meta">
              <div class="meta-row">
                <span>{{ $t('dashboard.agentStatus') }}</span>
                <strong>{{ agentStatusLabel }}</strong>
              </div>
              <div class="meta-row">
                <span>{{ $t('dashboard.lastHealthCheck') }}</span>
                <strong>{{ lastCheckLabel }}</strong>
              </div>
              <div class="meta-row">
                <span>{{ $t('dashboard.latency') }}</span>
                <strong>{{ latencyLabel }}</strong>
              </div>
              <div class="meta-row">
                <span>{{ $t('dashboard.queueDepth') }}</span>
                <strong>{{ formatNumber(health.queueDepth) }}</strong>
              </div>
            </div>
          </div>

          <p v-if="health.lastCheck?.errorMessage" class="provider-error">
            {{ health.lastCheck.errorMessage }}
          </p>
        </article>

        <article class="panel glass">
          <div class="panel-head">
            <h2>{{ $t('dashboard.systemSnapshot') }}</h2>
            <p>{{ $t('dashboard.systemSnapshotDescription') }}</p>
          </div>

          <dl class="snapshot-list">
            <div class="snapshot-row">
              <dt>{{ $t('dashboard.activeProvider') }}</dt>
              <dd>{{ providerName }}</dd>
            </div>
            <div class="snapshot-row">
              <dt>{{ $t('dashboard.model') }}</dt>
              <dd>{{ providerModel }}</dd>
            </div>
            <div class="snapshot-row">
              <dt>{{ $t('dashboard.language') }}</dt>
              <dd>{{ languageLabel }}</dd>
            </div>
            <div class="snapshot-row">
              <dt>{{ $t('dashboard.sessionTimeout') }}</dt>
              <dd>{{ settingsSummary.sessionTimeoutMinutes }} {{ $t('settings.minutes') }}</dd>
            </div>
            <div class="snapshot-row">
              <dt>{{ $t('dashboard.heartbeat') }}</dt>
              <dd>{{ health.intervalMinutes }} {{ $t('settings.minutes') }}</dd>
            </div>
            <div class="snapshot-row">
              <dt>{{ $t('dashboard.batchDelay') }}</dt>
              <dd>{{ settingsSummary.batchingDelayMs }} ms</dd>
            </div>
          </dl>
        </article>
      </section>

      <section class="dashboard-grid">
        <article class="panel glass">
          <div class="panel-head">
            <h2>{{ $t('dashboard.quickActions') }}</h2>
            <p>{{ $t('dashboard.quickActionsDescription') }}</p>
          </div>

          <div class="action-grid">
            <NuxtLink v-for="action in quickActions" :key="action.to" :to="action.to" class="action-card">
              <span class="action-icon">{{ action.icon }}</span>
              <div>
                <strong>{{ action.label }}</strong>
                <p>{{ action.description }}</p>
              </div>
            </NuxtLink>
          </div>
        </article>

        <article class="panel glass">
          <div class="panel-head">
            <h2>{{ $t('dashboard.recentHealthChecks') }}</h2>
            <p>{{ $t('dashboard.recentHealthChecksDescription') }}</p>
          </div>

          <div v-if="healthHistory.length === 0" class="history-empty">
            {{ $t('dashboard.noHealthHistory') }}
          </div>

          <div v-else class="history-list">
            <div class="history-row" v-for="entry in healthHistory" :key="entry.id">
              <div>
                <strong>{{ entry.provider || $t('dashboard.notConfigured') }}</strong>
                <p>{{ formatDateTime(entry.timestamp) }}</p>
              </div>
              <div class="history-metrics">
                <span class="status-badge compact" :class="statusBadgeClass(entry.status)">
                  {{ statusLabel(entry.status) }}
                </span>
                <small>{{ entry.latencyMs ? `${entry.latencyMs} ms` : '—' }}</small>
              </div>
            </div>
          </div>
        </article>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
interface HealthSnapshot {
  agent: {
    status: 'running' | 'stopped'
  }
  provider: {
    id: string
    name: string
    model: string
    status: 'healthy' | 'degraded' | 'down' | 'unconfigured'
  } | null
  lastCheck: {
    checkedAt: string
    providerId: string | null
    providerName: string | null
    providerType: string | null
    model: string | null
    status: 'healthy' | 'degraded' | 'down' | 'unconfigured'
    latencyMs: number | null
    errorMessage: string | null
  } | null
  queueDepth: number
  activity: {
    messagesToday: number
    sessionsToday: number
  }
  intervalMinutes: number
}

interface HealthHistoryEntry {
  id: number
  timestamp: string
  provider: string | null
  status: 'healthy' | 'degraded' | 'down' | 'unconfigured'
  latencyMs: number | null
  errorMessage: string | null
}

const { t } = useI18n()
const { apiFetch } = useApi()
const { user } = useAuth()
const isAdmin = computed(() => user.value?.role === 'admin')

const loading = ref(false)
const error = ref<string | null>(null)
const providersCount = ref(0)
const totalRequests = ref(0)
const healthHistory = ref<HealthHistoryEntry[]>([])
const health = ref<HealthSnapshot>({
  agent: { status: 'stopped' },
  provider: null,
  lastCheck: null,
  queueDepth: 0,
  activity: {
    messagesToday: 0,
    sessionsToday: 0,
  },
  intervalMinutes: 5,
})
const settingsSummary = ref({
  language: 'match',
  sessionTimeoutMinutes: 15,
  batchingDelayMs: 2500,
})

const statCards = computed(() => [
  {
    label: t('dashboard.cards.messages'),
    value: formatNumber(health.value.activity.messagesToday),
    meta: t('dashboard.cards.messagesMeta'),
  },
  {
    label: t('dashboard.cards.sessions'),
    value: formatNumber(health.value.activity.sessionsToday),
    meta: t('dashboard.cards.sessionsMeta'),
  },
  {
    label: t('dashboard.cards.queue'),
    value: formatNumber(health.value.queueDepth),
    meta: t('dashboard.cards.queueMeta'),
  },
  {
    label: t('dashboard.cards.requests'),
    value: formatNumber(totalRequests.value),
    meta: `${providersCount.value} ${t('dashboard.cards.providersMeta')}`,
  },
])

const quickActions = computed(() => [
  {
    to: '/memory',
    icon: '🧠',
    label: t('nav.memory'),
    description: t('dashboard.actions.memory'),
  },
  {
    to: '/settings',
    icon: '⚙️',
    label: t('nav.settings'),
    description: t('dashboard.actions.settings'),
  },
  {
    to: '/providers',
    icon: '🔌',
    label: t('nav.providers'),
    description: t('dashboard.actions.providers'),
  },
  {
    to: '/users',
    icon: '👥',
    label: t('nav.users'),
    description: t('dashboard.actions.users'),
  },
  {
    to: '/logs',
    icon: '📋',
    label: t('nav.logs'),
    description: t('dashboard.actions.logs'),
  },
  {
    to: '/usage',
    icon: '📈',
    label: t('nav.usage'),
    description: t('dashboard.actions.usage'),
  },
])

const providerName = computed(() => health.value.provider?.name || t('dashboard.notConfigured'))
const providerModel = computed(() => health.value.provider?.model || '—')
const providerStatus = computed(() => health.value.provider?.status ?? 'unconfigured')
const providerStatusLabel = computed(() => statusLabel(providerStatus.value))
const agentStatusLabel = computed(() => t(`dashboard.agentStates.${health.value.agent.status}`))
const lastCheckLabel = computed(() => {
  if (!health.value.lastCheck?.checkedAt) return t('dashboard.noChecksYet')
  return formatDateTime(health.value.lastCheck.checkedAt)
})
const latencyLabel = computed(() => {
  if (health.value.lastCheck?.latencyMs == null) return '—'
  return `${health.value.lastCheck.latencyMs} ms`
})
const languageLabel = computed(() => {
  return settingsSummary.value.language === 'match'
    ? t('settings.languageMatch')
    : settingsSummary.value.language
})

onMounted(async () => {
  if (!isAdmin.value) return
  await loadDashboard()
})

async function loadDashboard() {
  loading.value = true
  error.value = null

  try {
    const [healthData, historyData, providersData, usageData, settingsData] = await Promise.all([
      apiFetch<HealthSnapshot>('/api/health'),
      apiFetch<{ history: HealthHistoryEntry[] }>('/api/health/history?limit=5'),
      apiFetch<{ providers: Array<{ id: string }> }>('/api/providers'),
      apiFetch<{ allTime: { requests: number } }>('/api/stats/summary'),
      apiFetch<{
        language: string
        sessionTimeoutMinutes: number
        batchingDelayMs: number
      }>('/api/settings'),
    ])

    health.value = healthData
    healthHistory.value = historyData.history
    providersCount.value = providersData.providers.length
    totalRequests.value = usageData.allTime.requests
    settingsSummary.value = settingsData
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    loading.value = false
  }
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value)
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

function statusLabel(status: 'healthy' | 'degraded' | 'down' | 'unconfigured'): string {
  return t(`dashboard.providerStates.${status}`)
}

function statusBadgeClass(status: 'healthy' | 'degraded' | 'down' | 'unconfigured'): string {
  return `status-${status}`
}
</script>

<style scoped>
.dashboard-page {
  padding: 24px;
  max-width: 1180px;
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

.glass {
  background:
    radial-gradient(circle at top right, rgba(99, 102, 241, 0.1), transparent 32%),
    linear-gradient(180deg, rgba(255, 255, 255, 0.03), rgba(255, 255, 255, 0.015)),
    var(--color-bg-secondary);
  border: 1px solid rgba(255, 255, 255, 0.06);
  box-shadow: 0 18px 36px rgba(0, 0, 0, 0.18);
}

.dashboard-hero {
  border-radius: 24px;
  padding: 28px;
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 20px;
  margin-bottom: 18px;
}

.eyebrow,
.panel-kicker {
  font-size: 12px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: #93c5fd;
  margin-bottom: 8px;
}

.dashboard-hero h1 {
  margin: 0;
  font-size: 32px;
}

.dashboard-subtitle {
  margin-top: 8px;
  color: var(--color-text-secondary);
  max-width: 680px;
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

.stats-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 14px;
  margin-bottom: 18px;
}

.stat-card {
  padding: 20px;
  border-radius: 18px;
}

.stat-label {
  display: block;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--color-text-muted);
}

.stat-value {
  display: block;
  margin-top: 14px;
  font-size: 34px;
  color: var(--color-text);
}

.stat-meta {
  display: block;
  margin-top: 10px;
  color: var(--color-text-secondary);
  font-size: 13px;
}

.status-grid,
.dashboard-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  margin-bottom: 16px;
}

.panel {
  border-radius: 22px;
  padding: 22px;
}

.panel-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
}

.panel-head h2 {
  font-size: 18px;
  margin: 0;
}

.panel-head p {
  margin-top: 6px;
  font-size: 13px;
  color: var(--color-text-muted);
}

.provider-panel {
  overflow: hidden;
  position: relative;
}

.provider-summary {
  margin-top: 18px;
  display: flex;
  gap: 18px;
  align-items: center;
}

.signal-ring {
  width: 110px;
  height: 110px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: radial-gradient(circle, rgba(255, 255, 255, 0.08), transparent 65%);
  border: 1px solid rgba(255, 255, 255, 0.07);
  flex-shrink: 0;
}

.signal-ring span {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 22px currentColor;
}

.provider-meta {
  flex: 1;
  display: grid;
  gap: 10px;
}

.meta-row,
.snapshot-row,
.history-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: center;
}

.meta-row span,
.snapshot-row dt {
  color: var(--color-text-muted);
}

.meta-row strong,
.snapshot-row dd {
  color: var(--color-text);
  font-weight: 600;
  text-align: right;
}

.provider-error {
  margin-top: 16px;
  padding: 12px 14px;
  border-radius: 14px;
  background: rgba(239, 68, 68, 0.08);
  border: 1px solid rgba(239, 68, 68, 0.2);
  color: #fca5a5;
  font-size: 13px;
}

.snapshot-list {
  margin-top: 18px;
}

.snapshot-row {
  padding: 12px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}

.action-grid {
  margin-top: 18px;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.action-card {
  display: flex;
  gap: 12px;
  padding: 14px;
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.05);
  color: inherit;
}

.action-card:hover {
  border-color: rgba(129, 140, 248, 0.24);
}

.action-icon {
  font-size: 24px;
}

.action-card strong {
  display: block;
  color: var(--color-text);
}

.action-card p {
  margin-top: 4px;
  font-size: 13px;
  color: var(--color-text-muted);
}

.history-empty {
  margin-top: 18px;
  color: var(--color-text-muted);
}

.history-list {
  margin-top: 18px;
  display: grid;
  gap: 12px;
}

.history-row {
  padding: 14px;
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.05);
}

.history-row strong {
  color: var(--color-text);
}

.history-row p,
.history-row small {
  margin-top: 4px;
  color: var(--color-text-muted);
}

.history-metrics {
  text-align: right;
}

.status-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 92px;
  padding: 8px 12px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  border: 1px solid currentColor;
}

.status-badge.compact {
  min-width: 0;
  padding: 6px 10px;
  font-size: 11px;
}

.status-healthy {
  color: #4ade80;
}

.status-degraded {
  color: #facc15;
}

.status-down {
  color: #f87171;
}

.status-unconfigured {
  color: #94a3b8;
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

@media (max-width: 960px) {
  .dashboard-page {
    padding: 16px;
  }

  .stats-grid,
  .status-grid,
  .dashboard-grid,
  .action-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .dashboard-hero,
  .panel-head,
  .provider-summary,
  .meta-row,
  .snapshot-row,
  .history-row {
    flex-direction: column;
    align-items: flex-start;
  }

  .meta-row strong,
  .snapshot-row dd,
  .history-metrics {
    text-align: left;
  }
}
</style>
