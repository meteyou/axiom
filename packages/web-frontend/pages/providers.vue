<template>
  <div class="flex h-full flex-col overflow-hidden">
    <PageHeader :title="$t('providers.title')" :subtitle="$t('providers.subtitle')">
      <template #actions>
        <Button @click="openCreate">
          <AppIcon name="add" class="mr-1 h-4 w-4" />
          {{ $t('providers.addProvider') }}
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

      <!-- Success banner (test result) -->
      <Alert v-if="successMessage" variant="success" class="mb-4">
        <AlertDescription class="flex items-center justify-between">
          <span>{{ successMessage }}</span>
          <button
            type="button"
            class="ml-2 opacity-70 transition-opacity hover:opacity-100"
            :aria-label="$t('aria.closeAlert')"
            @click="successMessage = null"
          >
            <AppIcon name="close" class="h-4 w-4" />
          </button>
        </AlertDescription>
      </Alert>

      <!-- Loading state -->
      <div
        v-if="loading && providers.length === 0"
        class="flex flex-1 items-center justify-center py-20 text-sm text-muted-foreground"
      >
        {{ $t('logs.loading') }}
      </div>

      <!-- Empty state -->
      <div
        v-else-if="providers.length === 0"
        class="flex flex-1 flex-col items-center justify-center gap-4 py-20 text-center text-muted-foreground"
      >
        <AppIcon name="plug" size="xl" class="h-12 w-12 opacity-40" />
        <p class="text-sm">{{ $t('providers.noProviders') }}</p>
        <Button @click="openCreate">
          {{ $t('providers.addProvider') }}
        </Button>
      </div>

      <!-- Fallback provider dropdown -->
      <div v-else class="mb-4">
        <div class="flex items-center gap-4 rounded-xl border border-border bg-card p-4 shadow-sm">
          <div class="min-w-0 flex-1">
            <label for="fallback-select" class="block text-sm font-semibold text-foreground">
              {{ $t('providers.fallbackProvider') }}
            </label>
            <p class="mt-0.5 text-xs text-muted-foreground">
              {{ $t('providers.fallbackProviderHint') }}
            </p>
          </div>
          <Select
            id="fallback-select"
            :model-value="fallbackProviderId ?? ''"
            class="w-56"
            @update:model-value="handleFallbackChange"
          >
            <option value="">{{ $t('providers.fallbackNone') }}</option>
            <option
              v-for="p in fallbackOptions"
              :key="p.id"
              :value="p.id"
            >
              {{ p.name }}
            </option>
          </Select>
        </div>
      </div>

      <!-- Providers table -->
      <div v-if="providers.length > 0" class="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <div class="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow class="hover:bg-transparent">
                <TableHead>{{ $t('providers.columns.name') }}</TableHead>
                <TableHead>{{ $t('providers.columns.cost') }}</TableHead>
                <TableHead>{{ $t('providers.columns.status') }}</TableHead>
                <TableHead class="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow
                v-for="provider in sortedProviders"
                :key="provider.id"
                class="cursor-pointer"
                @click="openEdit(provider)"
              >
                <!-- Name + Base URL -->
                <TableCell>
                  <div class="min-w-0">
                    <div class="flex items-center gap-2">
                      <span class="font-semibold text-foreground">{{ provider.name }}</span>
                      <Badge v-if="provider.id === activeProviderId" variant="default" class="px-1.5 py-0 text-[10px]">
                        {{ $t('providers.active') }}
                      </Badge>
                    </div>
                    <span class="text-xs text-muted-foreground">
                      {{ getTypeLabel(provider.providerType) }}
                      <span class="opacity-40">·</span>
                      {{ provider.defaultModel }}
                    </span>
                  </div>
                </TableCell>

                <!-- Cost -->
                <TableCell>
                  <div v-if="provider.cost" class="text-xs text-muted-foreground">
                    <div class="flex items-center gap-1">
                      <span class="text-foreground font-medium">${{ formatCost(provider.cost.input) }}</span>
                      <span class="opacity-40">/</span>
                      <span class="text-foreground font-medium">${{ formatCost(provider.cost.output) }}</span>
                    </div>
                    <span class="text-[10px]">{{ $t('providers.costPerMillion') }}</span>
                  </div>
                  <span v-else class="text-xs text-muted-foreground">{{ $t('providers.costNA') }}</span>
                </TableCell>

                <!-- Status -->
                <TableCell>
                  <div v-if="testingId === provider.id" class="flex items-center gap-1.5">
                    <span
                      class="h-3.5 w-3.5 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent"
                      aria-hidden="true"
                    />
                    <span class="text-xs text-muted-foreground">{{ $t('providers.testing') }}</span>
                  </div>
                  <Badge v-else :variant="getStatusVariant(provider.status)">
                    {{ getStatusLabel(provider.status) }}
                  </Badge>
                </TableCell>

                <!-- Row actions -->
                <TableCell class="text-right" @click.stop>
                  <DropdownMenu>
                    <DropdownMenuTrigger>
                      <Button variant="ghost" size="icon-sm" :aria-label="$t('providers.columns.actions')">
                        <AppIcon name="moreVertical" class="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem @click="handleTest(provider.id)">
                        <AppIcon name="refresh" class="h-4 w-4" />
                        {{ $t('providers.testConnection') }}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        v-if="provider.id !== activeProviderId"
                        @click="handleActivate(provider.id)"
                      >
                        <AppIcon name="check" class="h-4 w-4" />
                        {{ $t('providers.setActive') }}
                      </DropdownMenuItem>
                      <DropdownMenuItem @click="openEdit(provider)">
                        <AppIcon name="edit" class="h-4 w-4" />
                        {{ $t('users.edit') }}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        destructive
                        :disabled="provider.id === activeProviderId"
                        @click="openDelete(provider)"
                      >
                        <AppIcon name="trash" class="h-4 w-4" />
                        {{ $t('providers.delete') }}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  </div>

  <!-- Add / Edit dialog -->
  <ProviderFormDialog
    :open="showForm"
    :mode="formMode"
    :provider="editingProvider"
    :presets="presets"
    @close="closeForm"
    @submit="handleSubmit"
    @oauth-complete="closeForm"
  />

  <!-- Delete confirmation dialog -->
  <ConfirmDialog
    :open="!!deleteTarget"
    :title="$t('providers.delete')"
    :description="$t('providers.deleteConfirm', { name: deleteTarget?.name ?? '' })"
    :confirm-label="$t('providers.deleteConfirmButton')"
    :cancel-label="$t('providers.deleteCancel')"
    destructive
    @confirm="handleDelete"
    @cancel="deleteTarget = null"
  />
</template>

<script setup lang="ts">
import type { Provider } from '~/composables/useProviders'
import type { ProviderFormPayload } from '~/components/ProviderFormDialog.vue'

const { t } = useI18n()

const {
  providers,
  activeProviderId,
  fallbackProviderId,
  presets,
  loading,
  error,
  testingId,
  fetchProviders,
  addProvider,
  updateProvider,
  deleteProvider,
  testProvider,
  activateProvider,
  setFallbackProvider,
} = useProviders()

/* ── State ── */
const showForm = ref(false)
const formMode = ref<'create' | 'edit'>('create')
const editingProvider = ref<Provider | null>(null)
const deleteTarget = ref<Provider | null>(null)
const successMessage = ref<string | null>(null)

const sortedProviders = computed(() =>
  [...providers.value].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
)

const fallbackOptions = computed(() =>
  providers.value
    .filter(p => p.id !== activeProviderId.value)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
)

onMounted(() => {
  fetchProviders()
})

/* ── Helpers ── */
function getTypeLabel(providerType: string): string {
  const preset = presets.value[providerType]
  return preset?.label ?? providerType
}

function getStatusVariant(status?: string): 'success' | 'destructive' | 'muted' {
  switch (status) {
    case 'connected': return 'success'
    case 'error': return 'destructive'
    default: return 'muted'
  }
}

function formatCost(value: number): string {
  if (value >= 1) return value.toFixed(2)
  if (value >= 0.01) return value.toFixed(2)
  return value.toFixed(3)
}

function getStatusLabel(status?: string): string {
  switch (status) {
    case 'connected': return t('providers.statusConnected')
    case 'error': return t('providers.statusError')
    default: return t('providers.statusUntested')
  }
}

function autoHideSuccess() {
  setTimeout(() => { successMessage.value = null }, 4000)
}

/* ── Create / Edit ── */
function openCreate() {
  formMode.value = 'create'
  editingProvider.value = null
  showForm.value = true
}

function openEdit(provider: Provider) {
  formMode.value = 'edit'
  editingProvider.value = provider
  showForm.value = true
}

function closeForm() {
  showForm.value = false
  editingProvider.value = null
}

async function handleSubmit(payload: ProviderFormPayload) {
  if (formMode.value === 'edit' && editingProvider.value) {
    const input: Record<string, string | number | undefined> = {
      name: payload.name,
      providerType: payload.providerType,
      baseUrl: payload.baseUrl,
      defaultModel: payload.defaultModel,
      degradedThresholdMs: payload.degradedThresholdMs,
    }
    if (payload.apiKey) {
      input.apiKey = payload.apiKey
    }
    const result = await updateProvider(editingProvider.value.id, input)
    if (result) closeForm()
  } else {
    const result = await addProvider({
      name: payload.name,
      providerType: payload.providerType,
      baseUrl: payload.baseUrl || undefined,
      apiKey: payload.apiKey || undefined,
      defaultModel: payload.defaultModel,
      degradedThresholdMs: payload.degradedThresholdMs,
    })
    if (result) closeForm()
  }
}

/* ── Delete ── */
function openDelete(provider: Provider) {
  deleteTarget.value = provider
}

async function handleDelete() {
  if (!deleteTarget.value) return
  const success = await deleteProvider(deleteTarget.value.id)
  if (success) {
    deleteTarget.value = null
  }
}

/* ── Test / Activate ── */
async function handleTest(id: string) {
  const result = await testProvider(id)
  if (result.success) {
    successMessage.value = result.message ?? t('providers.testSuccess')
  } else {
    error.value = result.error ?? t('providers.testFailed')
  }
  autoHideSuccess()
}

async function handleActivate(id: string) {
  await activateProvider(id)
}

async function handleFallbackChange(value: string) {
  await setFallbackProvider(value || null)
}
</script>
