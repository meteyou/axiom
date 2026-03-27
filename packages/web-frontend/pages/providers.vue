<template>
  <div class="flex h-full flex-col overflow-hidden">
    <PageHeader :title="$t('providers.title')" :subtitle="$t('providers.subtitle')">
      <template #actions>
        <Button @click="openAddForm">
          <AppIcon name="add" class="mr-1 h-4 w-4" />
          {{ $t('providers.addProvider') }}
        </Button>
      </template>
    </PageHeader>

    <div class="mx-auto flex w-full max-w-4xl flex-1 flex-col overflow-y-auto p-6">

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
      <Button @click="openAddForm">
        {{ $t('providers.addProvider') }}
      </Button>
    </div>

    <!-- Provider list -->
    <div v-else class="flex flex-col gap-3">
      <Card
        v-for="provider in providers"
        :key="provider.id"
        :class="provider.id === activeProviderId ? 'border-primary ring-1 ring-primary' : ''"
      >
        <CardContent class="p-4">
          <!-- Card header row -->
          <div class="flex flex-wrap items-start justify-between gap-3 sm:flex-nowrap">
            <!-- Provider info -->
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-2">
                <h3 class="text-base font-semibold text-foreground">{{ provider.name }}</h3>
                <Badge v-if="provider.id === activeProviderId" variant="default">
                  {{ $t('providers.active') }}
                </Badge>
                <Badge :variant="statusBadgeVariant(provider.status)">
                  {{ statusLabel(provider.status) }}
                </Badge>
              </div>
              <div class="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <span>{{ providerTypeLabel(provider.providerType) }}</span>
                <span class="opacity-40">·</span>
                <span>{{ provider.defaultModel }}</span>
                <span class="opacity-40">·</span>
                <span class="break-all">{{ provider.baseUrl }}</span>
              </div>
            </div>

            <!-- Action buttons -->
            <div class="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                :disabled="testingId === provider.id"
                @click="handleTest(provider.id)"
              >
                <span
                  v-if="testingId === provider.id"
                  class="mr-1 h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
                  aria-hidden="true"
                />
                {{ testingId === provider.id ? $t('providers.testing') : $t('providers.testConnection') }}
              </Button>
              <Button
                v-if="provider.id !== activeProviderId"
                variant="outline"
                size="sm"
                @click="handleActivate(provider.id)"
              >
                {{ $t('providers.setActive') }}
              </Button>
              <Button
                variant="outline"
                size="icon-sm"
                :title="$t('users.edit')"
                :aria-label="$t('users.edit')"
                @click="openEditForm(provider)"
              >
                <AppIcon name="edit" class="h-4 w-4" />
              </Button>
              <Button
                variant="outline"
                size="icon-sm"
                :disabled="provider.id === activeProviderId"
                :title="provider.id === activeProviderId ? $t('providers.cannotDeleteActive') : $t('providers.delete')"
                :aria-label="provider.id === activeProviderId ? $t('providers.cannotDeleteActive') : $t('providers.delete')"
                class="text-destructive hover:bg-destructive/10 hover:text-destructive border-destructive/30"
                @click="confirmDelete(provider)"
              >
                <AppIcon name="trash" class="h-4 w-4" />
              </Button>
            </div>
          </div>

          <!-- Test result feedback -->
          <Alert
            v-if="testResults[provider.id]"
            :variant="testResults[provider.id].success ? 'success' : 'destructive'"
            class="mt-3"
          >
            <AlertDescription>
              {{ testResults[provider.id].success ? testResults[provider.id].message : testResults[provider.id].error }}
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    </div>
    </div>
  </div>

  <!-- Add / Edit dialog -->
  <Dialog :open="showForm" @update:open="(v: boolean) => { if (!v) closeForm() }">
    <DialogContent class="max-w-lg">
      <DialogHeader>
        <DialogTitle>{{ isEditing ? $t('providers.editProvider') : $t('providers.addProvider') }}</DialogTitle>
      </DialogHeader>

      <form class="flex flex-col gap-4" @submit.prevent="handleSubmit">
        <!-- Name -->
        <div class="flex flex-col gap-1.5">
          <Label for="provider-name">{{ $t('providers.name') }}</Label>
          <Input
            id="provider-name"
            v-model="form.name"
            type="text"
            :placeholder="$t('providers.namePlaceholder')"
            required
          />
        </div>

        <!-- Type -->
        <div class="flex flex-col gap-1.5">
          <Label for="provider-type">{{ $t('providers.type') }}</Label>
          <Select
            id="provider-type"
            v-model="form.providerType"
            required
            @change="onTypeChange"
          >
            <option value="" disabled>{{ $t('providers.selectType') }}</option>
            <option v-for="(preset, key) in presets" :key="key" :value="key">
              {{ preset.label }}
            </option>
          </Select>
        </div>

        <!-- Base URL -->
        <div class="flex flex-col gap-1.5">
          <Label for="provider-url">{{ $t('providers.baseUrl') }}</Label>
          <Input
            id="provider-url"
            v-model="form.baseUrl"
            type="url"
            placeholder="https://..."
          />
        </div>

        <!-- API Key -->
        <div class="flex flex-col gap-1.5">
          <Label for="provider-key">{{ $t('providers.apiKey') }}</Label>
          <Input
            id="provider-key"
            v-model="form.apiKey"
            type="password"
            :placeholder="isEditing ? $t('providers.apiKeyHint') : $t('providers.apiKeyPlaceholder')"
          />
          <p v-if="isEditing" class="text-xs text-muted-foreground">{{ $t('providers.apiKeyHint') }}</p>
        </div>

        <!-- Model -->
        <div class="flex flex-col gap-1.5">
          <Label for="provider-model">{{ $t('providers.model') }}</Label>
          <Input
            id="provider-model"
            v-model="form.defaultModel"
            type="text"
            :placeholder="$t('providers.modelPlaceholder')"
            required
          />
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" @click="closeForm">{{ $t('providers.cancel') }}</Button>
          <Button type="submit">{{ $t('providers.save') }}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>

  <!-- Delete confirmation dialog -->
  <Dialog :open="!!deleteTarget" @update:open="(v: boolean) => { if (!v) deleteTarget = null }">
    <DialogContent class="max-w-sm">
      <DialogHeader>
        <DialogTitle>{{ $t('providers.delete') }}</DialogTitle>
        <DialogDescription>
          {{ $t('providers.deleteConfirm', { name: deleteTarget?.name ?? '' }) }}
        </DialogDescription>
      </DialogHeader>

      <DialogFooter>
        <Button variant="outline" @click="deleteTarget = null">{{ $t('providers.deleteCancel') }}</Button>
        <Button variant="destructive" @click="handleDelete">
          {{ $t('providers.deleteConfirmButton') }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import type { Provider } from '~/composables/useProviders'

const { t } = useI18n()
const {
  providers,
  activeProviderId,
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
} = useProviders()

// Form state
const showForm = ref(false)
const isEditing = ref(false)
const editingId = ref<string | null>(null)
const deleteTarget = ref<Provider | null>(null)
const testResults = ref<Record<string, { success: boolean; message?: string; error?: string }>>({})

const form = reactive({
  name: '',
  providerType: '',
  baseUrl: '',
  apiKey: '',
  defaultModel: '',
})

// Fetch on mount
onMounted(() => {
  fetchProviders()
})

function providerTypeLabel(type: string): string {
  const preset = presets.value[type]
  return preset?.label ?? type
}

function statusBadgeVariant(status?: string): 'success' | 'destructive' | 'muted' {
  switch (status) {
    case 'connected': return 'success'
    case 'error': return 'destructive'
    default: return 'muted'
  }
}

function statusLabel(status?: string): string {
  switch (status) {
    case 'connected': return t('providers.statusConnected')
    case 'error': return t('providers.statusError')
    default: return t('providers.statusUntested')
  }
}

function openAddForm() {
  isEditing.value = false
  editingId.value = null
  form.name = ''
  form.providerType = ''
  form.baseUrl = ''
  form.apiKey = ''
  form.defaultModel = ''
  showForm.value = true
}

function openEditForm(provider: Provider) {
  isEditing.value = true
  editingId.value = provider.id
  form.name = provider.name
  form.providerType = provider.providerType
  form.baseUrl = provider.baseUrl
  form.apiKey = ''
  form.defaultModel = provider.defaultModel
  showForm.value = true
}

function closeForm() {
  showForm.value = false
  editingId.value = null
}

function onTypeChange() {
  const preset = presets.value[form.providerType]
  if (preset && !isEditing.value) {
    form.baseUrl = preset.baseUrl
  }
}

async function handleSubmit() {
  if (isEditing.value && editingId.value) {
    const input: Record<string, string | undefined> = {
      name: form.name,
      providerType: form.providerType,
      baseUrl: form.baseUrl,
      defaultModel: form.defaultModel,
    }
    if (form.apiKey) {
      input.apiKey = form.apiKey
    }
    const result = await updateProvider(editingId.value, input)
    if (result) closeForm()
  } else {
    const result = await addProvider({
      name: form.name,
      providerType: form.providerType,
      baseUrl: form.baseUrl || undefined,
      apiKey: form.apiKey || undefined,
      defaultModel: form.defaultModel,
    })
    if (result) closeForm()
  }
}

function confirmDelete(provider: Provider) {
  deleteTarget.value = provider
}

async function handleDelete() {
  if (!deleteTarget.value) return
  const success = await deleteProvider(deleteTarget.value.id)
  if (success) {
    deleteTarget.value = null
  }
}

async function handleTest(id: string) {
  const result = await testProvider(id)
  testResults.value[id] = result
  setTimeout(() => {
    const updated = { ...testResults.value }
    delete updated[id]
    testResults.value = updated
  }, 5000)
}

async function handleActivate(id: string) {
  await activateProvider(id)
}
</script>
