<template>
  <!-- Admin gate -->
  <div
    v-if="!isAdmin"
    class="flex h-full flex-col items-center justify-center gap-3 p-10 text-center text-muted-foreground"
  >
    <AppIcon name="lock" size="xl" class="opacity-50" />
    <h1 class="text-lg font-semibold text-foreground">{{ $t('admin.title') }}</h1>
    <p class="max-w-xs text-sm">{{ $t('admin.description') }}</p>
  </div>

  <div v-else class="flex h-full flex-col overflow-hidden">
    <PageHeader :title="$t('usage.title')" :subtitle="$t('usage.subtitle')">
      <template #actions>
        <Button variant="outline" :disabled="loading" class="gap-2" @click="loadStats">
          <AppIcon name="refresh" class="h-4 w-4" />
          {{ $t('usage.refresh') }}
        </Button>
      </template>
    </PageHeader>

    <div class="mx-auto flex w-full max-w-6xl flex-1 flex-col overflow-y-auto p-6">

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

    <!-- Loading skeleton -->
    <div v-if="loading" class="space-y-4">
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Skeleton v-for="i in 4" :key="i" class="h-28 rounded-xl" />
      </div>
      <Skeleton class="h-40 rounded-xl" />
      <Skeleton class="h-72 rounded-xl" />
      <Skeleton class="h-52 rounded-xl" />
    </div>

    <template v-else>
      <!-- Summary cards (4-col → 2-col → 1-col) -->
      <section class="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card v-for="card in summaryCards" :key="card.label">
          <CardContent class="p-5">
            <span class="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              {{ card.label }}
            </span>
            <strong class="mt-3 block text-3xl font-bold text-foreground">{{ card.value }}</strong>
            <span class="mt-2 block text-sm text-muted-foreground">{{ card.meta }}</span>
          </CardContent>
        </Card>
      </section>

      <!-- Filter form card -->
      <Card class="mb-4">
        <CardContent class="p-5">
          <div class="mb-4">
            <h2 class="text-base font-semibold text-foreground">{{ $t('usage.filters.title') }}</h2>
            <p class="mt-1 text-sm text-muted-foreground">{{ $t('usage.filters.description') }}</p>
          </div>

          <form class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4" @submit.prevent="loadStats">
            <!-- Date from -->
            <div class="flex flex-col gap-1.5">
              <label class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {{ $t('usage.filters.dateFrom') }}
              </label>
              <Input v-model="filters.dateFrom" type="date" />
            </div>

            <!-- Date to -->
            <div class="flex flex-col gap-1.5">
              <label class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {{ $t('usage.filters.dateTo') }}
              </label>
              <Input v-model="filters.dateTo" type="date" />
            </div>

            <!-- Provider -->
            <div class="flex flex-col gap-1.5">
              <label class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {{ $t('usage.filters.provider') }}
              </label>
              <Select v-model="filters.provider" @change="filters.model = ''">
                <option value="">{{ $t('usage.filters.allProviders') }}</option>
                <option v-for="provider in availableProviders" :key="provider" :value="provider">
                  {{ provider }}
                </option>
              </Select>
            </div>

            <!-- Model -->
            <div class="flex flex-col gap-1.5">
              <label class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {{ $t('usage.filters.model') }}
              </label>
              <Select v-model="filters.model">
                <option value="">{{ $t('usage.filters.allModels') }}</option>
                <option v-for="model in availableModels" :key="model" :value="model">
                  {{ model }}
                </option>
              </Select>
            </div>

            <!-- Actions (spans full row) -->
            <div class="flex items-end gap-2 sm:col-span-2 lg:col-span-4 lg:justify-end">
              <Button type="submit">{{ $t('usage.filters.apply') }}</Button>
              <Button type="button" variant="outline" @click="resetFilters">
                {{ $t('usage.filters.reset') }}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <!-- No usage at all -->
      <Card v-if="!hasAnyUsage" class="mb-4">
        <CardContent class="flex flex-col items-center gap-3 py-14 text-center">
          <AppIcon name="trendDown" size="xl" class="opacity-40" />
          <h2 class="text-base font-semibold text-foreground">{{ $t('usage.emptyTitle') }}</h2>
          <p class="max-w-md text-sm text-muted-foreground">{{ $t('usage.emptyDescription') }}</p>
        </CardContent>
      </Card>

      <template v-else>
        <!-- No results for filters -->
        <Card v-if="!hasFilteredResults" class="mb-4">
          <CardContent class="flex flex-col items-center gap-3 py-10 text-center">
            <AppIcon name="compass" size="xl" class="opacity-40" />
            <h2 class="text-base font-semibold text-foreground">{{ $t('usage.emptyFilteredTitle') }}</h2>
            <p class="max-w-md text-sm text-muted-foreground">{{ $t('usage.emptyFilteredDescription') }}</p>
          </CardContent>
        </Card>

        <!-- Bar chart -->
        <Card class="mb-4">
          <CardContent class="p-5">
            <!-- Chart header -->
            <div class="mb-5 flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 class="text-base font-semibold text-foreground">{{ $t('usage.chart.title') }}</h2>
                <p class="mt-1 text-sm text-muted-foreground">{{ $t('usage.chart.description') }}</p>
              </div>
              <div class="text-right">
                <span class="block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {{ $t('usage.chart.rangeLabel') }}
                </span>
                <strong class="mt-1 block text-sm font-semibold text-foreground">{{ chartRangeLabel }}</strong>
              </div>
            </div>

            <!-- Empty chart -->
            <div
              v-if="chartSeries.length === 0 || chartMax === 0"
              class="flex min-h-[180px] items-center justify-center text-sm text-muted-foreground"
            >
              {{ $t('usage.chart.empty') }}
            </div>

            <!-- Chart body -->
            <div v-else class="flex gap-3">
              <!-- Y-axis labels -->
              <div class="flex w-14 shrink-0 flex-col justify-between pb-7 text-right">
                <span class="text-xs text-muted-foreground">{{ formatNumber(chartMax) }}</span>
                <span class="text-xs text-muted-foreground">{{ formatNumber(Math.round(chartMax / 2)) }}</span>
                <span class="text-xs text-muted-foreground">0</span>
              </div>

              <!-- Grid + bars -->
              <div class="relative min-h-[220px] flex-1 sm:min-h-[280px]">
                <!-- Horizontal grid lines -->
                <div class="pointer-events-none absolute inset-0 flex flex-col justify-between pb-7">
                  <div class="border-t border-dashed border-border/60" />
                  <div class="border-t border-dashed border-border/60" />
                  <div class="border-t border-dashed border-border/60" />
                </div>

                <!-- Bars -->
                <div
                  class="absolute inset-0 flex items-end gap-px pb-7 sm:gap-0.5"
                  :style="{ display: 'grid', gridTemplateColumns: `repeat(${chartSeries.length}, minmax(0, 1fr))`, alignItems: 'end', paddingBottom: '28px' }"
                >
                  <div
                    v-for="point in chartSeries"
                    :key="point.day"
                    class="group flex min-w-0 flex-col items-center justify-end"
                    style="height: 100%"
                    :title="`${formatFullDate(point.day)} · ${formatNumber(point.totalTokens)} ${$t('usage.table.columns.totalTokens')} · ${formatCurrency(point.estimatedCost)}`"
                  >
                    <div
                      class="w-full max-w-[26px] rounded-t-sm bg-primary transition-opacity group-hover:opacity-80"
                      :style="{ height: `${point.height}%` }"
                    />
                  </div>
                </div>

                <!-- X-axis labels -->
                <div
                  class="absolute bottom-0 left-0 right-0 flex h-7 items-end"
                  :style="{ display: 'grid', gridTemplateColumns: `repeat(${xAxisLabels.length}, minmax(0, 1fr))` }"
                >
                  <span
                    v-for="point in xAxisLabels"
                    :key="point.day"
                    class="overflow-hidden text-center text-[10px] text-muted-foreground"
                  >
                    {{ point.label }}
                  </span>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <!-- Breakdown table -->
        <Card class="mb-4">
          <CardContent class="p-5">
            <!-- Table header -->
            <div class="mb-4 flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 class="text-base font-semibold text-foreground">{{ $t('usage.table.title') }}</h2>
                <p class="mt-1 text-sm text-muted-foreground">{{ $t('usage.table.description') }}</p>
              </div>
              <div class="text-right">
                <span class="block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {{ $t('usage.table.selectedTotal') }}
                </span>
                <strong class="mt-1 block text-sm font-semibold text-foreground">
                  {{ formatNumber(breakdown.totals.totalTokens) }}
                </strong>
              </div>
            </div>

            <!-- Scrollable table -->
            <div class="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{{ $t('usage.table.columns.provider') }}</TableHead>
                    <TableHead>{{ $t('usage.table.columns.model') }}</TableHead>
                    <TableHead class="text-right">{{ $t('usage.table.columns.promptTokens') }}</TableHead>
                    <TableHead class="text-right">{{ $t('usage.table.columns.completionTokens') }}</TableHead>
                    <TableHead class="text-right">{{ $t('usage.table.columns.totalTokens') }}</TableHead>
                    <TableHead class="text-right">{{ $t('usage.table.columns.cost') }}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow v-if="breakdown.rows.length === 0">
                    <TableCell colspan="6" class="py-8 text-center text-muted-foreground">
                      {{ $t('usage.table.empty') }}
                    </TableCell>
                  </TableRow>
                  <TableRow
                    v-for="row in breakdown.rows"
                    :key="`${row.provider}-${row.model}`"
                  >
                    <TableCell class="font-medium">{{ row.provider || '—' }}</TableCell>
                    <TableCell class="font-mono text-xs">{{ row.model || '—' }}</TableCell>
                    <TableCell class="text-right tabular-nums">{{ formatNumber(row.promptTokens) }}</TableCell>
                    <TableCell class="text-right tabular-nums">{{ formatNumber(row.completionTokens) }}</TableCell>
                    <TableCell class="text-right font-semibold tabular-nums">{{ formatNumber(row.totalTokens) }}</TableCell>
                    <TableCell class="text-right tabular-nums">{{ formatCurrency(row.estimatedCost) }}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </template>
    </template>
    </div>
  </div>
</template>

<script setup lang="ts">
interface UsageTotals {
  requests: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  estimatedCost: number
}

interface UsageSummaryResponse {
  today: UsageTotals
  week: UsageTotals
  month: UsageTotals
  allTime: UsageTotals
}

interface UsageRow extends UsageTotals {
  provider?: string
  model?: string
  day?: string
  hour?: string
}

interface UsageStatsResponse {
  groupBy: string[]
  rows: UsageRow[]
  totals: UsageTotals
  availableProviders: string[]
  availableModels: string[]
}

const { t, locale } = useI18n()
const { apiFetch } = useApi()
const { user } = useAuth()
const isAdmin = computed(() => user.value?.role === 'admin')

function formatDateInput(date: Date): string {
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

function getInitialFilters() {
  const end = new Date()
  const start = new Date(end)
  start.setDate(start.getDate() - 29)
  return {
    dateFrom: formatDateInput(start),
    dateTo: formatDateInput(end),
    provider: '',
    model: '',
  }
}

const filters = reactive(getInitialFilters())
const loading = ref(false)
const error = ref<string | null>(null)
const summary = ref<UsageSummaryResponse>({
  today: { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCost: 0 },
  week: { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCost: 0 },
  month: { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCost: 0 },
  allTime: { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCost: 0 },
})
const daily = ref<UsageStatsResponse>({
  groupBy: ['day'],
  rows: [],
  totals: { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCost: 0 },
  availableProviders: [],
  availableModels: [],
})
const breakdown = ref<UsageStatsResponse>({
  groupBy: ['provider', 'model'],
  rows: [],
  totals: { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCost: 0 },
  availableProviders: [],
  availableModels: [],
})

const availableProviders = ref<string[]>([])
const availableModels = ref<string[]>([])

const hasAnyUsage = computed(() => summary.value.allTime.totalTokens > 0)
const hasFilteredResults = computed(
  () => breakdown.value.rows.length > 0 || daily.value.rows.some((row) => row.totalTokens > 0),
)

const summaryCards = computed(() => [
  {
    label: t('usage.summary.tokensToday'),
    value: formatNumber(summary.value.today.totalTokens),
    meta: t('usage.summary.tokensTodayMeta'),
  },
  {
    label: t('usage.summary.costToday'),
    value: formatCurrency(summary.value.today.estimatedCost),
    meta: t('usage.summary.costTodayMeta'),
  },
  {
    label: t('usage.summary.tokensMonth'),
    value: formatNumber(summary.value.month.totalTokens),
    meta: t('usage.summary.tokensMonthMeta'),
  },
  {
    label: t('usage.summary.costMonth'),
    value: formatCurrency(summary.value.month.estimatedCost),
    meta: t('usage.summary.costMonthMeta'),
  },
])

const chartSeries = computed(() => {
  if (!filters.dateFrom || !filters.dateTo) return [] as Array<{
    day: string; label: string; totalTokens: number; estimatedCost: number; height: number
  }>

  const start = new Date(`${filters.dateFrom}T00:00:00`)
  const end = new Date(`${filters.dateTo}T00:00:00`)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return []

  const dailyMap = new Map(
    daily.value.rows
      .filter((row) => row.day)
      .map((row) => [row.day as string, row]),
  )

  const points: Array<{ day: string; label: string; totalTokens: number; estimatedCost: number }> = []
  const cursor = new Date(start)

  while (cursor <= end) {
    const day = formatDateInput(cursor)
    const row = dailyMap.get(day)
    points.push({
      day,
      label: formatShortDate(day),
      totalTokens: row?.totalTokens ?? 0,
      estimatedCost: row?.estimatedCost ?? 0,
    })
    cursor.setDate(cursor.getDate() + 1)
  }

  const max = Math.max(...points.map((p) => p.totalTokens), 0)

  return points.map((point) => ({
    ...point,
    height: max > 0 ? Math.max((point.totalTokens / max) * 100, point.totalTokens > 0 ? 8 : 0) : 0,
  }))
})

const chartMax = computed(() => Math.max(...chartSeries.value.map((p) => p.totalTokens), 0))
const chartRangeLabel = computed(() => {
  if (!filters.dateFrom || !filters.dateTo) return '—'
  return `${formatFullDate(filters.dateFrom)} → ${formatFullDate(filters.dateTo)}`
})

// For x-axis: show a label every N bars so it doesn't crowd
const xAxisLabels = computed(() => {
  const series = chartSeries.value
  if (series.length === 0) return []
  const step = series.length <= 14 ? 1 : series.length <= 31 ? 3 : 7
  return series.map((point, i) => ({
    day: point.day,
    label: i % step === 0 ? point.label : '',
  }))
})

onMounted(async () => {
  if (!isAdmin.value) return
  await loadStats()
})

async function loadStats() {
  loading.value = true
  error.value = null

  try {
    const [summaryData, dailyData, breakdownData] = await Promise.all([
      apiFetch<UsageSummaryResponse>('/api/stats/summary'),
      apiFetch<UsageStatsResponse>(`/api/stats/usage?${buildQuery(['day'])}`),
      apiFetch<UsageStatsResponse>(`/api/stats/usage?${buildQuery(['provider', 'model'])}`),
    ])

    summary.value = summaryData
    daily.value = dailyData
    breakdown.value = breakdownData
    availableProviders.value = dailyData.availableProviders
    availableModels.value = dailyData.availableModels
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    loading.value = false
  }
}

function buildQuery(groupBy: string[]): string {
  const params = new URLSearchParams()
  params.set('group_by', groupBy.join(','))
  if (filters.dateFrom) params.set('date_from', filters.dateFrom)
  if (filters.dateTo) params.set('date_to', filters.dateTo)
  if (filters.provider) params.set('provider', filters.provider)
  if (filters.model) params.set('model', filters.model)
  return params.toString()
}

function resetFilters() {
  Object.assign(filters, getInitialFilters())
  loadStats()
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat(locale.value).format(value)
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat(locale.value, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)
}

function formatShortDate(value: string): string {
  return new Intl.DateTimeFormat(locale.value, {
    month: 'short',
    day: 'numeric',
  }).format(new Date(`${value}T00:00:00`))
}

function formatFullDate(value: string): string {
  return new Intl.DateTimeFormat(locale.value, {
    dateStyle: 'medium',
  }).format(new Date(`${value}T00:00:00`))
}
</script>
