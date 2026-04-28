<template>
  <!-- Task Viewer (detail mode) -->
  <TaskEventsViewer
    v-if="selectedTaskId"
    :task-id="selectedTaskId"
    @back="closeViewer"
    @restarted="onTaskRestarted"
  />

  <div v-else class="flex h-full flex-col overflow-hidden">
    <PageHeader :title="$t('tasks.title')" :subtitle="$t('tasks.subtitle')" />

    <!-- Filter toolbar -->
    <div class="flex-shrink-0 border-b border-border px-5 py-3">
      <div class="flex flex-col gap-2 lg:flex-row lg:items-center">
        <div class="flex flex-1 flex-wrap items-center gap-2">
          <Select v-model="filters.status" @update:model-value="onFilterChange">
            <SelectTrigger class="w-full sm:w-[160px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">{{ $t('tasks.filters.allStatuses') }}</SelectItem>
              <SelectItem value="running">{{ $t('tasks.status.running') }}</SelectItem>
              <SelectItem value="paused">{{ $t('tasks.status.paused') }}</SelectItem>
              <SelectItem value="completed">{{ $t('tasks.status.completed') }}</SelectItem>
              <SelectItem value="failed">{{ $t('tasks.status.failed') }}</SelectItem>
            </SelectContent>
          </Select>

          <Select v-model="filters.triggerType" @update:model-value="onFilterChange">
            <SelectTrigger class="w-full sm:w-[160px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">{{ $t('tasks.filters.allTriggers') }}</SelectItem>
              <SelectItem value="user">{{ $t('tasks.trigger.user') }}</SelectItem>
              <SelectItem value="agent">{{ $t('tasks.trigger.agent') }}</SelectItem>
              <SelectItem value="cronjob">{{ $t('tasks.trigger.cronjob') }}</SelectItem>
              <SelectItem value="heartbeat">{{ $t('tasks.trigger.heartbeat') }}</SelectItem>
              <SelectItem value="consolidation">{{ $t('tasks.trigger.consolidation') }}</SelectItem>
            </SelectContent>
          </Select>

          <Select v-model="filters.providerFilter" @update:model-value="onFilterChange">
            <SelectTrigger class="w-full sm:w-[240px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">{{ $t('tasks.filters.allProviders') }}</SelectItem>
              <SelectItem v-if="hasDefaultProviderFilter" :value="TASK_DEFAULT_PROVIDER_FILTER">
                {{ $t('tasks.filters.defaultProvider') }}
              </SelectItem>
              <SelectItem
                v-for="option in providerModelFilterOptions"
                :key="option.value"
                :value="option.value"
              >
                {{ option.label }}
              </SelectItem>
            </SelectContent>
          </Select>

          <div class="flex items-center gap-2">
            <span class="text-xs text-muted-foreground">{{ $t('tasks.filters.fromDate') }}</span>
            <Input
              v-model="filters.createdFrom"
              type="date"
              class="w-[145px]"
              :aria-label="$t('tasks.filters.fromDate')"
              @change="onFilterChange"
            />
          </div>

          <div class="flex items-center gap-2">
            <span class="text-xs text-muted-foreground">{{ $t('tasks.filters.toDate') }}</span>
            <Input
              v-model="filters.createdTo"
              type="date"
              class="w-[145px]"
              :aria-label="$t('tasks.filters.toDate')"
              @change="onFilterChange"
            />
          </div>
        </div>

        <Button variant="outline" :disabled="loading" class="gap-2" @click="loadTasks(pagination.page)">
          <AppIcon name="refresh" class="h-4 w-4" />
          {{ $t('tasks.refresh') }}
        </Button>
      </div>
    </div>

    <!-- Content area -->
    <div class="flex flex-1 flex-col overflow-y-auto">
      <!-- Error banner -->
      <Alert v-if="error" variant="destructive" class="m-4 mb-0">
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
      <div v-if="loading && tasks.length === 0" class="space-y-3 p-6">
        <Skeleton v-for="i in 5" :key="i" class="h-14 rounded-lg" />
      </div>

      <!-- Empty state -->
      <div
        v-else-if="tasks.length === 0"
        class="flex flex-1 flex-col items-center justify-center gap-3 p-10 text-center"
      >
        <AppIcon name="tasks" size="xl" class="opacity-40" />
        <h2 class="text-base font-semibold text-foreground">{{ $t('tasks.emptyTitle') }}</h2>
        <p class="max-w-md text-sm text-muted-foreground">{{ $t('tasks.emptyDescription') }}</p>
      </div>

      <!-- Tasks table -->
      <div v-else class="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead
                class="cursor-pointer select-none hover:text-foreground"
                @click="sortBy('name')"
              >
                <span class="inline-flex items-center gap-1">
                  {{ $t('tasks.columns.name') }}
                  <SortIndicator :field="'name'" :sort-field="sortField" :sort-direction="sortDirection" />
                </span>
              </TableHead>
              <TableHead>{{ $t('tasks.columns.status') }}</TableHead>
              <TableHead>{{ $t('tasks.columns.trigger') }}</TableHead>
              <TableHead
                class="cursor-pointer select-none text-right hover:text-foreground"
                @click="sortBy('duration')"
              >
                <span class="inline-flex items-center justify-end gap-1">
                  {{ $t('tasks.columns.duration') }}
                  <SortIndicator :field="'duration'" :sort-field="sortField" :sort-direction="sortDirection" />
                </span>
              </TableHead>
              <TableHead
                class="cursor-pointer select-none text-right hover:text-foreground"
                @click="sortBy('promptTokens')"
              >
                <span class="inline-flex items-center justify-end gap-1">
                  {{ $t('tasks.columns.tokens') }}
                  <SortIndicator :field="'promptTokens'" :sort-field="sortField" :sort-direction="sortDirection" />
                </span>
              </TableHead>
              <TableHead
                class="cursor-pointer select-none text-right hover:text-foreground"
                @click="sortBy('estimatedCost')"
              >
                <span class="inline-flex items-center justify-end gap-1">
                  {{ $t('tasks.columns.cost') }}
                  <SortIndicator :field="'estimatedCost'" :sort-field="sortField" :sort-direction="sortDirection" />
                </span>
              </TableHead>
              <TableHead
                class="cursor-pointer select-none text-right hover:text-foreground"
                @click="sortBy('createdAt')"
              >
                <span class="inline-flex items-center justify-end gap-1">
                  {{ $t('tasks.columns.created') }}
                  <SortIndicator :field="'createdAt'" :sort-field="sortField" :sort-direction="sortDirection" />
                </span>
              </TableHead>
              <TableHead class="w-[70px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow
              v-for="task in sortedTasks"
              :key="task.id"
              class="cursor-pointer"
              @click="openViewer(task.id)"
            >
              <TableCell class="max-w-[240px] truncate font-medium">
                {{ task.name }}
              </TableCell>
              <TableCell>
                <Badge :variant="statusVariant(task.status)">
                  {{ $t(`tasks.status.${task.status}`) }}
                </Badge>
              </TableCell>
              <TableCell>
                <div class="flex flex-col items-start gap-1">
                  <Badge variant="outline">
                    {{ $t(`tasks.trigger.${task.triggerType}`) }}
                  </Badge>
                  <span
                    v-if="formatTriggerModel(task)"
                    class="text-xs text-muted-foreground"
                    :title="task.isDefaultModel ? $t('tasks.triggerModelDefaultTooltip') : undefined"
                  >
                    {{ formatTriggerModel(task) }}
                  </span>
                </div>
              </TableCell>
              <TableCell class="text-right tabular-nums text-muted-foreground">
                {{ formatDuration(task) }}
              </TableCell>
              <TableCell class="text-right tabular-nums text-muted-foreground">
                <span :title="`Prompt: ${formatNumber(task.promptTokens)} · Completion: ${formatNumber(task.completionTokens)}`">
                  {{ formatNumber(task.promptTokens + task.completionTokens) }}
                </span>
              </TableCell>
              <TableCell class="text-right tabular-nums text-muted-foreground">
                {{ formatCurrency(task.estimatedCost) }}
              </TableCell>
              <TableCell class="text-right text-sm text-muted-foreground">
                {{ formatCreatedAt(task.createdAt) }}
              </TableCell>
              <TableCell class="text-right">
                <Button
                  v-if="task.status === 'running'"
                  variant="ghost"
                  size="sm"
                  class="h-8 w-8 p-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  :title="$t('tasks.killButton')"
                  @click.stop="confirmKill(task)"
                >
                  <AppIcon name="kill" size="sm" />
                </Button>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>

        <!-- Pagination -->
        <div
          v-if="pagination.totalPages > 1"
          class="flex items-center justify-between border-t border-border px-4 py-3"
        >
          <span class="text-sm text-muted-foreground">
            {{ pagination.total }} tasks · Page {{ pagination.page }} of {{ pagination.totalPages }}
          </span>
          <div class="flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              :disabled="pagination.page <= 1"
              @click="loadTasks(pagination.page - 1)"
            >
              <AppIcon name="arrowLeft" size="sm" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              :disabled="pagination.page >= pagination.totalPages"
              @click="loadTasks(pagination.page + 1)"
            >
              <AppIcon name="arrowRight" size="sm" />
            </Button>
          </div>
        </div>
      </div>
    </div>

    <!-- Kill confirmation dialog -->
    <ConfirmDialog
      :open="killDialog.open"
      :title="$t('tasks.killConfirmTitle')"
      :description="$t('tasks.killConfirmDescription')"
      :confirm-label="$t('tasks.killButton')"
      :loading="killDialog.loading"
      destructive
      @confirm="executeKill"
      @cancel="killDialog.open = false"
    />
  </div>
</template>

<script setup lang="ts">
import type { Task } from '~/api/tasks'
import TaskEventsViewer from '~/features/tasks/components/TaskEventsViewer.vue'
import {
  TASK_DEFAULT_PROVIDER_FILTER,
  encodeTaskProviderModelFilter,
  useTasksList,
} from '~/features/tasks/composables/useTasksList'

const { locale, t } = useI18n()
const { formatNumber, formatCurrency } = useFormat()

const selectedTaskId = ref<string | null>(null)

function openViewer(taskId: string) {
  selectedTaskId.value = taskId
}

function closeViewer() {
  selectedTaskId.value = null
  loadTasks(pagination.value.page)
}

// After a successful restart, swap the viewer to the new task so the user
// can watch it run. We also refresh the list in the background so the new
// row shows up when they navigate back.
function onTaskRestarted(newTaskId: string) {
  selectedTaskId.value = newTaskId
  loadTasks(1).catch(() => {
    // Background refresh — errors are already surfaced by useTasksList.
  })
}

const {
  tasks,
  providerOptions,
  sortedTasks,
  loading,
  error,
  pagination,
  filters,
  sortField,
  sortDirection,
  loadTasks,
  killTask,
  sortBy,
  startPolling,
  stopPolling,
} = useTasksList()

const hasDefaultProviderFilter = computed(() =>
  providerOptions.value.some(option => option.isDefaultModel === true),
)

const providerModelFilterOptions = computed(() => {
  const seen = new Set<string>()

  return providerOptions.value
    .filter((option): option is { provider: string; model: string; isDefaultModel: boolean | null } =>
      Boolean(option.provider && option.model),
    )
    .map((option) => ({
      value: encodeTaskProviderModelFilter(option.provider, option.model),
      label: `${option.provider} (${option.model})`,
    }))
    .filter((option) => {
      if (seen.has(option.value)) return false
      seen.add(option.value)
      return true
    })
})

const killDialog = reactive({
  open: false,
  loading: false,
  taskId: null as string | null,
})

function confirmKill(task: Task) {
  killDialog.taskId = task.id
  killDialog.open = true
}

async function executeKill() {
  if (!killDialog.taskId) return

  killDialog.loading = true
  await killTask(killDialog.taskId)
  killDialog.loading = false
  killDialog.open = false
  killDialog.taskId = null
}

function onFilterChange() {
  loadTasks(1)
}

function statusVariant(status: string): 'default' | 'success' | 'destructive' | 'warning' | 'muted' {
  switch (status) {
    case 'running': return 'default'
    case 'completed': return 'success'
    case 'failed': return 'destructive'
    case 'paused': return 'warning'
    default: return 'muted'
  }
}

function formatTriggerModel(task: Task): string | null {
  const provider = task.provider
  const model = task.model
  if (!provider && !model) return null

  const parts = [provider, model].filter(Boolean).join(' – ')
  if (task.isDefaultModel === true) {
    return t('tasks.triggerModelDefault', { value: parts })
  }
  return parts
}

function formatDuration(task: Task): string {
  const start = task.startedAt ? new Date(task.startedAt.replace(' ', 'T') + 'Z').getTime() : null
  if (!start) return '—'

  const end = task.completedAt
    ? new Date(task.completedAt.replace(' ', 'T') + 'Z').getTime()
    : Date.now()

  const diffMs = end - start
  if (diffMs < 0) return '—'

  const seconds = Math.floor(diffMs / 1000)
  if (seconds < 60) return `${seconds}s`

  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`

  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return `${hours}h ${remainingMinutes}m`
}

function formatCreatedAt(dateStr: string): string {
  try {
    const date = new Date(dateStr.replace(' ', 'T') + 'Z')
    return new Intl.DateTimeFormat(locale.value, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date)
  } catch {
    return dateStr
  }
}

onMounted(async () => {
  await loadTasks()
  startPolling(5000)
})

onUnmounted(() => {
  stopPolling()
})
</script>
