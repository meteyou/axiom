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
            <h2>{{ $t('dashboard.systemSnapshot') }}</h2>
            <p>{{ $t('dashboard.systemSnapshotDescription') }}</p>
          </div>

          <dl class="snapshot-list">
            <div class="snapshot-row">
              <dt>{{ $t('dashboard.activeProvider') }}</dt>
              <dd>{{ activeProviderName }}</dd>
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
              <dd>{{ settingsSummary.heartbeatIntervalMinutes }} {{ $t('settings.minutes') }}</dd>
            </div>
            <div class="snapshot-row">
              <dt>{{ $t('dashboard.batchDelay') }}</dt>
              <dd>{{ settingsSummary.batchingDelayMs }} ms</dd>
            </div>
          </dl>
        </article>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
const { t } = useI18n()
const { apiFetch } = useApi()
const { user } = useAuth()
const isAdmin = computed(() => user.value?.role === 'admin')

const loading = ref(false)
const error = ref<string | null>(null)
const stats = ref({
  users: 0,
  providers: 0,
  logs: 0,
  requests: 0,
  estimatedCost: 0,
})
const providers = ref<Array<{ id: string; name: string }>>([])
const activeProvider = ref<string | null>(null)
const settingsSummary = ref({
  language: 'match',
  sessionTimeoutMinutes: 15,
  heartbeatIntervalMinutes: 5,
  batchingDelayMs: 2500,
})

const statCards = computed(() => [
  {
    label: t('dashboard.cards.users'),
    value: formatNumber(stats.value.users),
    meta: t('dashboard.cards.usersMeta'),
  },
  {
    label: t('dashboard.cards.providers'),
    value: formatNumber(stats.value.providers),
    meta: t('dashboard.cards.providersMeta'),
  },
  {
    label: t('dashboard.cards.logs'),
    value: formatNumber(stats.value.logs),
    meta: t('dashboard.cards.logsMeta'),
  },
  {
    label: t('dashboard.cards.requests'),
    value: formatNumber(stats.value.requests),
    meta: formatCurrency(stats.value.estimatedCost),
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

const activeProviderName = computed(() => {
  const match = providers.value.find((provider) => provider.id === activeProvider.value)
  return match?.name || t('dashboard.notConfigured')
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
    const [usersData, providersData, logsData, usageData, settingsData] = await Promise.all([
      apiFetch<{ users: Array<{ id: number }> }>('/api/users'),
      apiFetch<{ providers: Array<{ id: string; name: string }>; activeProvider: string | null }>('/api/providers'),
      apiFetch<{ pagination: { total: number } }>('/api/logs?limit=1'),
      apiFetch<{ summary: { requests: number; estimatedCost: number } }>('/api/usage'),
      apiFetch<{
        language: string
        sessionTimeoutMinutes: number
        heartbeatIntervalMinutes: number
        batchingDelayMs: number
      }>('/api/settings'),
    ])

    stats.value = {
      users: usersData.users.length,
      providers: providersData.providers.length,
      logs: logsData.pagination.total,
      requests: usageData.summary.requests,
      estimatedCost: usageData.summary.estimatedCost,
    }
    providers.value = providersData.providers
    activeProvider.value = providersData.activeProvider
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

function formatCurrency(value: number): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(value)
}
</script>

<style scoped>
.dashboard-page {
  padding: 24px;
  max-width: 1160px;
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
    linear-gradient(180deg, rgba(255, 255, 255, 0.03), rgba(255, 255, 255, 0.01)),
    var(--color-bg-secondary);
  border: 1px solid rgba(255, 255, 255, 0.06);
  box-shadow: 0 14px 30px rgba(0, 0, 0, 0.16);
}

.dashboard-hero {
  border-radius: 22px;
  padding: 26px;
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 20px;
  margin-bottom: 18px;
}

.eyebrow {
  font-size: 12px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: #a5b4fc;
  margin-bottom: 8px;
}

.dashboard-hero h1 {
  margin: 0;
  font-size: 30px;
}

.dashboard-subtitle {
  margin-top: 8px;
  color: var(--color-text-secondary);
  max-width: 640px;
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
  padding: 18px;
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
  margin-top: 12px;
  font-size: 32px;
  color: var(--color-text);
}

.stat-meta {
  display: block;
  margin-top: 10px;
  color: var(--color-text-secondary);
  font-size: 13px;
}

.dashboard-grid {
  display: grid;
  grid-template-columns: 1.4fr 1fr;
  gap: 16px;
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

.snapshot-list {
  margin-top: 18px;
}

.snapshot-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}

.snapshot-row dt {
  color: var(--color-text-muted);
}

.snapshot-row dd {
  color: var(--color-text);
  font-weight: 600;
  text-align: right;
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
  .dashboard-grid,
  .action-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .dashboard-hero {
    flex-direction: column;
  }
}
</style>
