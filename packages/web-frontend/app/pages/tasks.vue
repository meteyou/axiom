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

  <!-- Task Viewer (detail mode) -->
  <TaskViewer
    v-else-if="selectedTaskId"
    :task-id="selectedTaskId"
    @back="closeViewer"
  />

  <div v-else class="flex h-full flex-col overflow-hidden">
    <PageHeader :title="$t('tasks.title')" :subtitle="$t('tasks.subtitle')" />

    <!-- Filter toolbar -->
    <div class="flex-shrink-0 border-b border-border px-5 py-3">
      <div class="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div class="flex flex-1 items-center gap-2">
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
            </SelectContent>
          </Select>
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
                <Badge variant="outline">
                  {{ $t(`tasks.trigger.${task.triggerType}`) }}
                </Badge>
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
import type { Task } from '~/composables/useTasks'

const { locale } = useI18n()
const { formatNumber, formatCurrency } = useFormat()
const { user } = useAuth()
const isAdmin = computed(() => user.value?.role === 'admin')

// Task viewer state
const selectedTaskId = ref<string | null>(null)

function openViewer(taskId: string) {
  selectedTaskId.value = taskId
}

function closeViewer() {
  selectedTaskId.value = null
  loadTasks(pagination.value.page)
}

// === Tasks ===
const {
  tasks,
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
} = useTasks()

// Kill dialog state
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
  if (!isAdmin.value) return
  await loadTasks()
  startPolling(5000)
})

onUnmounted(() => {
  stopPolling()
})
</script>
