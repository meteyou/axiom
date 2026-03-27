<template>
  <!-- Admin gate -->
  <div
    v-if="!isAdmin"
    class="flex h-full flex-col items-center justify-center gap-3 p-10 text-center text-muted-foreground"
  >
    <AppIcon name="lock" class="h-10 w-10 opacity-50" />
    <h1 class="text-lg font-semibold text-foreground">{{ $t('admin.title') }}</h1>
    <p class="max-w-xs text-sm">{{ $t('admin.description') }}</p>
  </div>

  <div v-else class="flex h-full flex-col overflow-hidden">
    <PageHeader :title="$t('dashboard.title')" :subtitle="$t('dashboard.subtitle')">
      <template #actions>
        <Button variant="outline" :disabled="loading" class="gap-2" @click="loadDashboard">
          <AppIcon name="refresh" class="h-4 w-4" />
          {{ $t('dashboard.refresh') }}
        </Button>
      </template>
    </PageHeader>

    <div class="mx-auto flex w-full max-w-5xl flex-1 flex-col overflow-y-auto p-6">

    <!-- Error banner -->
    <Alert v-if="error" variant="destructive" class="mb-4">
      <AlertDescription class="flex items-center justify-between">
        <span>{{ error }}</span>
        <button
          type="button"
          class="ml-2 opacity-70 transition-opacity hover:opacity-100"
          :aria-label="$t('aria.closeAlert')"
          @click="error = null"
        >
          <AppIcon name="close" class="h-4 w-4" />
        </button>
      </AlertDescription>
    </Alert>

    <!-- Loading skeletons -->
    <template v-if="loading">
      <!-- Stat skeleton row -->
      <div class="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Skeleton v-for="i in 4" :key="i" class="h-28 rounded-xl" />
      </div>
      <!-- Panel skeleton row -->
      <div class="mb-4 grid grid-cols-1 gap-4 md:grid-cols-2">
        <Skeleton class="h-52 rounded-xl" />
        <Skeleton class="h-52 rounded-xl" />
      </div>
      <!-- Bottom skeleton row -->
      <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Skeleton class="h-64 rounded-xl" />
        <Skeleton class="h-64 rounded-xl" />
      </div>
    </template>

    <template v-else>
      <!-- Stat cards (4-col → 2-col → 1-col) -->
      <section class="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card v-for="card in statCards" :key="card.label">
          <CardContent class="p-5">
            <span class="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              {{ card.label }}
            </span>
            <strong class="mt-3 block text-4xl font-bold text-foreground">{{ card.value }}</strong>
            <span class="mt-2 block text-sm text-muted-foreground">{{ card.meta }}</span>
          </CardContent>
        </Card>
      </section>

      <!-- Provider health + System snapshot (2-col → 1-col) -->
      <section class="mb-4 grid grid-cols-1 gap-4 md:grid-cols-2">
        <!-- Provider health -->
        <Card>
          <CardHeader class="pb-3">
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p class="mb-1 text-xs font-semibold uppercase tracking-widest text-primary">
                  {{ $t('dashboard.providerHealth') }}
                </p>
                <CardTitle class="text-base">{{ providerName }}</CardTitle>
                <CardDescription>{{ providerModel }}</CardDescription>
              </div>
              <Badge :variant="statusBadgeVariant(providerStatus)">
                {{ providerStatusLabel }}
              </Badge>
            </div>
          </CardHeader>
          <CardContent class="pt-0">
            <div class="flex flex-wrap items-center gap-4">
              <!-- CSS signal dot indicator (no gradient ring) -->
              <div class="flex h-16 w-16 shrink-0 items-center justify-center rounded-full border border-border bg-muted/40">
                <span
                  class="h-5 w-5 rounded-full"
                  :class="statusDotClass(providerStatus)"
                />
              </div>
              <dl class="flex-1 space-y-2">
                <div class="flex items-center justify-between gap-2 text-sm">
                  <dt class="text-muted-foreground">{{ $t('dashboard.agentStatus') }}</dt>
                  <dd class="font-semibold text-foreground">{{ agentStatusLabel }}</dd>
                </div>
                <div class="flex items-center justify-between gap-2 text-sm">
                  <dt class="text-muted-foreground">{{ $t('dashboard.lastHealthCheck') }}</dt>
                  <dd class="font-semibold text-foreground">{{ lastCheckLabel }}</dd>
                </div>
                <div class="flex items-center justify-between gap-2 text-sm">
                  <dt class="text-muted-foreground">{{ $t('dashboard.latency') }}</dt>
                  <dd class="font-semibold text-foreground">{{ latencyLabel }}</dd>
                </div>
                <div class="flex items-center justify-between gap-2 text-sm">
                  <dt class="text-muted-foreground">{{ $t('dashboard.queueDepth') }}</dt>
                  <dd class="font-semibold text-foreground">{{ formatNumber(health.queueDepth) }}</dd>
                </div>
              </dl>
            </div>

            <Alert v-if="health.lastCheck?.errorMessage" variant="destructive" class="mt-4">
              <AlertDescription>{{ health.lastCheck.errorMessage }}</AlertDescription>
            </Alert>
          </CardContent>
        </Card>

        <!-- System snapshot -->
        <Card>
          <CardHeader class="pb-3">
            <CardTitle>{{ $t('dashboard.systemSnapshot') }}</CardTitle>
            <CardDescription>{{ $t('dashboard.systemSnapshotDescription') }}</CardDescription>
          </CardHeader>
          <CardContent class="pt-0">
            <dl class="divide-y divide-border">
              <div class="flex items-center justify-between gap-2 py-2.5 text-sm">
                <dt class="text-muted-foreground">{{ $t('dashboard.activeProvider') }}</dt>
                <dd class="font-semibold text-foreground">{{ providerName }}</dd>
              </div>
              <div class="flex items-center justify-between gap-2 py-2.5 text-sm">
                <dt class="text-muted-foreground">{{ $t('dashboard.model') }}</dt>
                <dd class="font-semibold text-foreground">{{ providerModel }}</dd>
              </div>
              <div class="flex items-center justify-between gap-2 py-2.5 text-sm">
                <dt class="text-muted-foreground">{{ $t('dashboard.language') }}</dt>
                <dd class="font-semibold text-foreground">{{ languageLabel }}</dd>
              </div>
              <div class="flex items-center justify-between gap-2 py-2.5 text-sm">
                <dt class="text-muted-foreground">{{ $t('dashboard.sessionTimeout') }}</dt>
                <dd class="font-semibold text-foreground">
                  {{ settingsSummary.sessionTimeoutMinutes }} {{ $t('settings.minutes') }}
                </dd>
              </div>
              <div class="flex items-center justify-between gap-2 py-2.5 text-sm">
                <dt class="text-muted-foreground">{{ $t('dashboard.heartbeat') }}</dt>
                <dd class="font-semibold text-foreground">
                  {{ health.intervalMinutes }} {{ $t('settings.minutes') }}
                </dd>
              </div>
              <div class="flex items-center justify-between gap-2 py-2.5 text-sm">
                <dt class="text-muted-foreground">{{ $t('dashboard.batchDelay') }}</dt>
                <dd class="font-semibold text-foreground">{{ settingsSummary.batchingDelayMs }} ms</dd>
              </div>
            </dl>
          </CardContent>
        </Card>
      </section>

      <!-- Quick actions + Health history (2-col → 1-col) -->
      <section class="grid grid-cols-1 gap-4 md:grid-cols-2">
        <!-- Quick actions -->
        <Card>
          <CardHeader class="pb-3">
            <CardTitle>{{ $t('dashboard.quickActions') }}</CardTitle>
            <CardDescription>{{ $t('dashboard.quickActionsDescription') }}</CardDescription>
          </CardHeader>
          <CardContent class="pt-0">
            <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <NuxtLink
                v-for="action in quickActions"
                :key="action.to"
                :to="action.to"
                class="flex items-start gap-3 rounded-lg border border-border bg-muted/30 p-3 transition-colors hover:border-primary/40 hover:bg-muted/60"
              >
                <AppIcon :name="action.icon" class="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
                <div class="min-w-0">
                  <strong class="block text-sm font-semibold text-foreground">{{ action.label }}</strong>
                  <p class="mt-0.5 text-xs text-muted-foreground">{{ action.description }}</p>
                </div>
              </NuxtLink>
            </div>
          </CardContent>
        </Card>

        <!-- Health history -->
        <Card>
          <CardHeader class="pb-3">
            <CardTitle>{{ $t('dashboard.recentHealthChecks') }}</CardTitle>
            <CardDescription>{{ $t('dashboard.recentHealthChecksDescription') }}</CardDescription>
          </CardHeader>
          <CardContent class="pt-0">
            <p v-if="healthHistory.length === 0" class="py-6 text-center text-sm text-muted-foreground">
              {{ $t('dashboard.noHealthHistory') }}
            </p>
            <ul v-else class="space-y-2">
              <li
                v-for="entry in healthHistory"
                :key="entry.id"
                class="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/30 p-3"
              >
                <div class="min-w-0">
                  <strong class="block truncate text-sm font-semibold text-foreground">
                    {{ entry.provider || $t('dashboard.notConfigured') }}
                  </strong>
                  <p class="mt-0.5 text-xs text-muted-foreground">{{ formatDateTime(entry.timestamp) }}</p>
                </div>
                <div class="flex shrink-0 flex-col items-end gap-1">
                  <Badge :variant="statusBadgeVariant(entry.status)">
                    {{ statusLabel(entry.status) }}
                  </Badge>
                  <span class="text-xs text-muted-foreground">
                    {{ entry.latencyMs ? `${entry.latencyMs} ms` : '—' }}
                  </span>
                </div>
              </li>
            </ul>
          </CardContent>
        </Card>
      </section>
    </template>
    </div>
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
    icon: 'brain',
    label: t('nav.memory'),
    description: t('dashboard.actions.memory'),
  },
  {
    to: '/settings',
    icon: 'settings',
    label: t('nav.settings'),
    description: t('dashboard.actions.settings'),
  },
  {
    to: '/providers',
    icon: 'plug',
    label: t('nav.providers'),
    description: t('dashboard.actions.providers'),
  },
  {
    to: '/users',
    icon: 'users',
    label: t('nav.users'),
    description: t('dashboard.actions.users'),
  },
  {
    to: '/logs',
    icon: 'logs',
    label: t('nav.logs'),
    description: t('dashboard.actions.logs'),
  },
  {
    to: '/usage',
    icon: 'trendDown',
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

type ProviderStatus = 'healthy' | 'degraded' | 'down' | 'unconfigured'

function statusLabel(status: ProviderStatus): string {
  return t(`dashboard.providerStates.${status}`)
}

function statusBadgeVariant(status: ProviderStatus): 'success' | 'warning' | 'destructive' | 'muted' {
  switch (status) {
    case 'healthy': return 'success'
    case 'degraded': return 'warning'
    case 'down': return 'destructive'
    default: return 'muted'
  }
}

function statusDotClass(status: ProviderStatus): string {
  switch (status) {
    case 'healthy': return 'bg-success'
    case 'degraded': return 'bg-warning'
    case 'down': return 'bg-destructive'
    default: return 'bg-muted-foreground'
  }
}
</script>
