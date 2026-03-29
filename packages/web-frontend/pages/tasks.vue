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
    <PageHeader :title="$t('tasks.title')" :subtitle="$t('tasks.subtitle')" />

    <!-- Tabs -->
    <Tabs v-model="activeTab" class="flex flex-1 flex-col overflow-hidden">
      <div class="flex-shrink-0 border-b border-border px-5">
        <TabsList>
          <TabsTrigger value="tasks">{{ $t('tasks.tabs.tasks') }}</TabsTrigger>
          <TabsTrigger value="scheduled">{{ $t('tasks.tabs.scheduled') }}</TabsTrigger>
        </TabsList>
      </div>

      <!-- Tasks Tab -->
      <TabsContent value="tasks" class="flex flex-1 flex-col overflow-hidden mt-0">
        <!-- Filter toolbar -->
        <div class="flex-shrink-0 border-b border-border px-5 py-3">
          <div class="flex flex-wrap items-center gap-2">
            <Select v-model="filters.status" class="w-[160px]" @change="onFilterChange">
              <option value="">{{ $t('tasks.filters.allStatuses') }}</option>
              <option value="running">{{ $t('tasks.status.running') }}</option>
              <option value="paused">{{ $t('tasks.status.paused') }}</option>
              <option value="completed">{{ $t('tasks.status.completed') }}</option>
              <option value="failed">{{ $t('tasks.status.failed') }}</option>
            </Select>

            <Select v-model="filters.triggerType" class="w-[160px]" @change="onFilterChange">
              <option value="">{{ $t('tasks.filters.allTriggers') }}</option>
              <option value="user">{{ $t('tasks.trigger.user') }}</option>
              <option value="agent">{{ $t('tasks.trigger.agent') }}</option>
              <option value="cronjob">{{ $t('tasks.trigger.cronjob') }}</option>
            </Select>

            <div class="flex-1" />

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
                <TableRow v-for="task in sortedTasks" :key="task.id">
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
                      @click="confirmKill(task)"
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
      </TabsContent>

      <!-- Scheduled Tasks Tab -->
      <TabsContent value="scheduled" class="flex flex-1 flex-col overflow-hidden mt-0">
        <!-- Toolbar -->
        <div class="flex-shrink-0 border-b border-border px-5 py-3">
          <div class="flex items-center justify-between">
            <div />
            <div class="flex items-center gap-2">
              <Button variant="outline" :disabled="cronjobsLoading" class="gap-2" @click="loadCronjobs">
                <AppIcon name="refresh" class="h-4 w-4" />
                {{ $t('tasks.refresh') }}
              </Button>
              <Button class="gap-2" @click="openCreateCronjob">
                <AppIcon name="add" class="h-4 w-4" />
                {{ $t('cronjobs.create') }}
              </Button>
            </div>
          </div>
        </div>

        <div class="flex flex-1 flex-col overflow-y-auto">
          <!-- Error banner -->
          <Alert v-if="cronjobsError" variant="destructive" class="m-4 mb-0">
            <AlertDescription class="flex items-center justify-between">
              <span>{{ cronjobsError }}</span>
              <button
                type="button"
                class="ml-2 opacity-70 transition-opacity hover:opacity-100"
                :aria-label="$t('aria.closeAlert')"
                @click="cronjobsError = null"
              >
                <AppIcon name="close" class="h-4 w-4" />
              </button>
            </AlertDescription>
          </Alert>

          <!-- Success banner -->
          <Alert v-if="cronjobsSuccess" variant="success" class="m-4 mb-0">
            <AlertDescription class="flex items-center justify-between">
              <span>{{ cronjobsSuccess }}</span>
              <button
                type="button"
                class="ml-2 opacity-70 transition-opacity hover:opacity-100"
                :aria-label="$t('aria.closeAlert')"
                @click="cronjobsClearSuccess"
              >
                <AppIcon name="close" class="h-4 w-4" />
              </button>
            </AlertDescription>
          </Alert>

          <!-- Loading skeleton -->
          <div v-if="cronjobsLoading && cronjobs.length === 0" class="space-y-3 p-6">
            <Skeleton v-for="i in 3" :key="i" class="h-14 rounded-lg" />
          </div>

          <!-- Empty state -->
          <div
            v-else-if="cronjobs.length === 0"
            class="flex flex-1 flex-col items-center justify-center gap-3 p-10 text-center"
          >
            <AppIcon name="calendar" size="xl" class="opacity-40" />
            <h2 class="text-base font-semibold text-foreground">{{ $t('cronjobs.emptyTitle') }}</h2>
            <p class="max-w-md text-sm text-muted-foreground">{{ $t('cronjobs.emptyDescription') }}</p>
            <Button class="mt-2 gap-2" @click="openCreateCronjob">
              <AppIcon name="add" class="h-4 w-4" />
              {{ $t('cronjobs.create') }}
            </Button>
          </div>

          <!-- Cronjobs table -->
          <div v-else class="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{{ $t('cronjobs.columns.name') }}</TableHead>
                  <TableHead>{{ $t('cronjobs.columns.schedule') }}</TableHead>
                  <TableHead>{{ $t('cronjobs.columns.provider') }}</TableHead>
                  <TableHead>{{ $t('cronjobs.columns.enabled') }}</TableHead>
                  <TableHead>{{ $t('cronjobs.columns.lastRun') }}</TableHead>
                  <TableHead class="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow
                  v-for="cj in cronjobs"
                  :key="cj.id"
                  class="cursor-pointer"
                  @click="openEditCronjob(cj)"
                >
                  <TableCell class="max-w-[200px] truncate font-medium">
                    {{ cj.name }}
                  </TableCell>
                  <TableCell>
                    <div class="flex flex-col">
                      <span class="text-sm">{{ cj.scheduleHuman }}</span>
                      <span class="text-xs text-muted-foreground font-mono">{{ cj.schedule }}</span>
                    </div>
                  </TableCell>
                  <TableCell class="text-muted-foreground">
                    {{ cj.provider || $t('cronjobs.defaultProvider') }}
                  </TableCell>
                  <TableCell @click.stop>
                    <Switch
                      :model-value="cj.enabled"
                      @update:model-value="(val: boolean) => handleToggle(cj.id, val)"
                    />
                  </TableCell>
                  <TableCell>
                    <div v-if="cj.lastRunAt" class="flex flex-col">
                      <div class="flex items-center gap-1.5">
                        <Badge :variant="lastRunStatusVariant(cj.lastRunStatus)">
                          {{ cj.lastRunStatus ?? '—' }}
                        </Badge>
                      </div>
                      <span class="text-xs text-muted-foreground">{{ formatCreatedAt(cj.lastRunAt) }}</span>
                    </div>
                    <span v-else class="text-sm text-muted-foreground">—</span>
                  </TableCell>
                  <TableCell @click.stop>
                    <DropdownMenu>
                      <DropdownMenuTrigger as-child>
                        <Button variant="ghost" size="sm" class="h-8 w-8 p-0">
                          <AppIcon name="moreVertical" size="sm" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem @click="openEditCronjob(cj)">
                          <AppIcon name="edit" size="sm" class="mr-2" />
                          {{ $t('common.edit') }}
                        </DropdownMenuItem>
                        <DropdownMenuItem @click="handleTrigger(cj)">
                          <AppIcon name="send" size="sm" class="mr-2" />
                          {{ $t('cronjobs.runNow') }}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem destructive @click="confirmDeleteCronjob(cj)">
                          <AppIcon name="trash" size="sm" class="mr-2" />
                          {{ $t('common.delete') }}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
        </div>
      </TabsContent>
    </Tabs>

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

    <!-- Cronjob form dialog -->
    <CronjobFormDialog
      :open="cronjobDialog.open"
      :mode="cronjobDialog.mode"
      :cronjob="cronjobDialog.cronjob"
      :loading="cronjobDialog.loading"
      @close="cronjobDialog.open = false"
      @submit="handleCronjobSubmit"
    />

    <!-- Delete cronjob confirmation -->
    <ConfirmDialog
      :open="deleteCronjobDialog.open"
      :title="$t('cronjobs.deleteConfirmTitle')"
      :description="$t('cronjobs.deleteConfirmDescription')"
      :confirm-label="$t('common.delete')"
      :loading="deleteCronjobDialog.loading"
      destructive
      @confirm="executeDeleteCronjob"
      @cancel="deleteCronjobDialog.open = false"
    />
  </div>
</template>

<script setup lang="ts">
import type { Task } from '~/composables/useTasks'
import type { Cronjob } from '~/composables/useCronjobs'

const { t, locale } = useI18n()
const { formatNumber, formatCurrency } = useFormat()
const { user } = useAuth()
const isAdmin = computed(() => user.value?.role === 'admin')

const activeTab = ref('tasks')

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

function lastRunStatusVariant(status: string | null): 'default' | 'success' | 'destructive' | 'warning' | 'muted' {
  switch (status) {
    case 'running': return 'default'
    case 'completed': return 'success'
    case 'failed': return 'destructive'
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

// === Cronjobs ===
const {
  cronjobs,
  loading: cronjobsLoading,
  error: cronjobsError,
  success: cronjobsSuccess,
  loadCronjobs,
  createCronjob,
  updateCronjob,
  deleteCronjob,
  toggleCronjob,
  triggerCronjob,
  clearSuccess: cronjobsClearSuccess,
} = useCronjobs()

// Create/Edit dialog
const cronjobDialog = reactive({
  open: false,
  mode: 'create' as 'create' | 'edit',
  cronjob: null as Cronjob | null,
  loading: false,
})

function openCreateCronjob() {
  cronjobDialog.mode = 'create'
  cronjobDialog.cronjob = null
  cronjobDialog.open = true
}

function openEditCronjob(cj: Cronjob) {
  cronjobDialog.mode = 'edit'
  cronjobDialog.cronjob = cj
  cronjobDialog.open = true
}

async function handleCronjobSubmit(form: { name: string; prompt: string; schedule: string; provider?: string }) {
  cronjobDialog.loading = true

  if (cronjobDialog.mode === 'create') {
    const result = await createCronjob(form)
    if (result) {
      cronjobDialog.open = false
    }
  } else if (cronjobDialog.cronjob) {
    const result = await updateCronjob(cronjobDialog.cronjob.id, form)
    if (result) {
      cronjobDialog.open = false
    }
  }

  cronjobDialog.loading = false
}

async function handleToggle(id: string, enabled: boolean) {
  await toggleCronjob(id, enabled)
}

async function handleTrigger(cj: Cronjob) {
  const result = await triggerCronjob(cj.id)
  if (result) {
    cronjobsSuccess.value = t('cronjobs.triggerSuccess', { name: cj.name })
    setTimeout(() => cronjobsClearSuccess(), 3000)
  }
}

// Delete dialog
const deleteCronjobDialog = reactive({
  open: false,
  loading: false,
  cronjobId: null as string | null,
})

function confirmDeleteCronjob(cj: Cronjob) {
  deleteCronjobDialog.cronjobId = cj.id
  deleteCronjobDialog.open = true
}

async function executeDeleteCronjob() {
  if (!deleteCronjobDialog.cronjobId) return
  deleteCronjobDialog.loading = true
  await deleteCronjob(deleteCronjobDialog.cronjobId)
  deleteCronjobDialog.loading = false
  deleteCronjobDialog.open = false
  deleteCronjobDialog.cronjobId = null
}

onMounted(async () => {
  if (!isAdmin.value) return
  await Promise.all([loadTasks(), loadCronjobs()])
  startPolling(5000)
})

onUnmounted(() => {
  stopPolling()
})
</script>
