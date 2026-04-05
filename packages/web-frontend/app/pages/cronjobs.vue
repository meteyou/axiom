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
    <PageHeader :title="$t('cronjobs.pageTitle')" :subtitle="$t('cronjobs.pageSubtitle')">
      <template #actions>
        <Button variant="outline" :disabled="loading" class="gap-2" @click="loadCronjobs">
          <AppIcon name="refresh" class="h-4 w-4" />
          {{ $t('tasks.refresh') }}
        </Button>
        <Button class="gap-2" @click="openCreateCronjob">
          <AppIcon name="add" class="h-4 w-4" />
          {{ $t('cronjobs.create') }}
        </Button>
      </template>
    </PageHeader>

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

      <!-- Success banner -->
      <Alert v-if="success" variant="success" class="m-4 mb-0">
        <AlertDescription class="flex items-center justify-between">
          <span>{{ success }}</span>
          <button
            type="button"
            class="ml-2 opacity-70 transition-opacity hover:opacity-100"
            :aria-label="$t('aria.closeAlert')"
            @click="clearSuccess"
          >
            <AppIcon name="close" class="h-4 w-4" />
          </button>
        </AlertDescription>
      </Alert>

      <!-- Loading skeleton -->
      <div v-if="loading && cronjobs.length === 0" class="space-y-3 p-6">
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
              <TableHead>{{ $t('cronjobs.columns.actionType') }}</TableHead>
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
              <TableCell class="max-w-[200px] font-medium">
                <div class="flex items-center gap-1.5">
                  <span class="truncate">{{ cj.name }}</span>
                  <Badge v-if="cj.toolsOverride" variant="outline" class="shrink-0 text-xs">
                    {{ $t('cronjobs.badges.customTools') }}
                  </Badge>
                  <Badge v-if="cj.skillsOverride" variant="outline" class="shrink-0 text-xs">
                    {{ $t('cronjobs.badges.customSkills') }}
                  </Badge>
                  <Badge v-if="cj.systemPromptOverride" variant="outline" class="shrink-0 text-xs">
                    {{ $t('cronjobs.badges.customPrompt') }}
                  </Badge>
                </div>
              </TableCell>
              <TableCell>
                <div class="flex flex-col">
                  <span class="text-sm">{{ cj.scheduleHuman }}</span>
                  <span class="font-mono text-xs text-muted-foreground">{{ cj.schedule }}</span>
                </div>
              </TableCell>
              <TableCell>
                <Badge :variant="cj.actionType === 'injection' ? 'warning' : 'default'">
                  {{ cj.actionType === 'injection' ? $t('cronjobs.actionTypeInjection') : $t('cronjobs.actionTypeTask') }}
                </Badge>
              </TableCell>
              <TableCell class="text-muted-foreground">
                {{ cj.actionType === 'injection' ? '—' : (cj.provider || $t('cronjobs.defaultProvider')) }}
              </TableCell>
              <TableCell @click.stop>
                <Switch
                  :checked="cj.enabled"
                  @update:checked="(val: boolean) => handleToggle(cj.id, val)"
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
import type { Cronjob } from '~/composables/useCronjobs'

const { t, locale } = useI18n()
const { user } = useAuth()
const isAdmin = computed(() => user.value?.role === 'admin')

// === Cronjobs ===
const {
  cronjobs,
  loading,
  error,
  success,
  loadCronjobs,
  createCronjob,
  updateCronjob,
  deleteCronjob,
  toggleCronjob,
  triggerCronjob,
  clearSuccess,
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

async function handleCronjobSubmit(form: { name: string; prompt: string; schedule: string; actionType?: 'task' | 'injection'; provider?: string; toolsOverride?: string | null; skillsOverride?: string | null; systemPromptOverride?: string | null }) {
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
    success.value = t('cronjobs.triggerSuccess', { name: cj.name })
    setTimeout(() => clearSuccess(), 3000)
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

function lastRunStatusVariant(status: string | null): 'default' | 'success' | 'destructive' | 'warning' | 'muted' {
  switch (status) {
    case 'running': return 'default'
    case 'completed': return 'success'
    case 'failed': return 'destructive'
    default: return 'muted'
  }
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
  await loadCronjobs()
})
</script>
