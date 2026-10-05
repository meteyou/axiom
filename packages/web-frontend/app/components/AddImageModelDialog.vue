<template>
  <Dialog :open="open" @update:open="(v: boolean) => { if (!v) emit('close') }">
    <DialogContent class="max-w-md">
      <DialogHeader>
        <DialogTitle>{{ $t('providers.imageModels.addDialogTitle') }}</DialogTitle>
        <DialogDescription>
          {{ $t('providers.imageModels.addDialogDescription') }}
        </DialogDescription>
      </DialogHeader>

      <div class="flex flex-col gap-3">
        <Input
          v-model="search"
          type="text"
          :placeholder="$t('providers.addModelSearch')"
          autofocus
        />

        <div v-if="loading" class="flex items-center gap-2 py-4 text-xs text-muted-foreground">
          <span class="h-3 w-3 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
          {{ $t('providers.loadingModels') }}
        </div>

        <div v-else-if="loadError" class="flex flex-col gap-1">
          <span class="text-xs text-destructive">{{ $t('providers.modelsLoadError') }}</span>
          <span class="break-words text-xs text-muted-foreground">{{ loadError }}</span>
        </div>

        <div v-else class="flex max-h-72 flex-col gap-0 divide-y divide-border overflow-hidden overflow-y-auto rounded-md border border-border">
          <label
            v-for="model in filteredModels"
            :key="model.id"
            :class="[
              'flex items-center gap-3 px-3 py-2 text-sm transition-colors',
              isAlreadyEnabled(model.id) ? 'opacity-50' : 'cursor-pointer hover:bg-accent/50',
              selected.has(model.id) ? 'bg-accent/30' : '',
            ]"
          >
            <input
              type="checkbox"
              :checked="selected.has(model.id)"
              :disabled="isAlreadyEnabled(model.id)"
              class="h-4 w-4 rounded border-border text-primary focus:ring-primary"
              @change="toggleSelected(model.id)"
            >
            <span class="flex min-w-0 flex-1 flex-col">
              <span class="truncate">{{ model.name }}</span>
              <span class="truncate font-mono text-[10px] text-muted-foreground">{{ model.id }}</span>
            </span>
            <Badge
              v-if="model.input.includes('image')"
              variant="outline"
              class="shrink-0 px-1.5 py-0 text-[10px]"
              :title="$t('providers.imageModels.editingHint')"
            >
              {{ $t('providers.imageModels.editing') }}
            </Badge>
            <span v-if="isAlreadyEnabled(model.id)" class="shrink-0 text-[10px] text-muted-foreground">
              {{ $t('providers.addModelAlreadyEnabled') }}
            </span>
          </label>

          <div v-if="filteredModels.length === 0 && !canAddCustom" class="px-3 py-4 text-xs text-muted-foreground">
            {{ $t('providers.addModelEmpty') }}
          </div>

          <button
            v-if="canAddCustom"
            type="button"
            :class="[
              'flex items-center gap-3 px-3 py-2 text-left text-sm transition-colors hover:bg-accent/50',
              selected.has(search.trim()) ? 'bg-accent/30' : '',
            ]"
            @click="toggleSelected(search.trim())"
          >
            <span class="flex h-4 w-4 items-center justify-center rounded border border-primary text-primary">
              <AppIcon v-if="selected.has(search.trim())" name="check" class="h-3 w-3" />
              <span v-else class="text-xs leading-none">+</span>
            </span>
            <span class="flex min-w-0 flex-1 flex-col">
              <span class="truncate">{{ $t('providers.addModelCustom', { name: search.trim() }) }}</span>
              <span class="truncate font-mono text-[10px] text-muted-foreground">{{ search.trim() }}</span>
            </span>
          </button>
        </div>

        <p v-if="selected.size > 0" class="text-xs text-muted-foreground">
          {{ $t('providers.addModelSelected', { count: selected.size }) }}
        </p>
      </div>

      <DialogFooter>
        <Button variant="outline" :disabled="saving" @click="emit('close')">
          {{ $t('providers.cancel') }}
        </Button>
        <Button :disabled="selected.size === 0 || saving" @click="handleAdd">
          <span
            v-if="saving"
            class="mr-1.5 h-3.5 w-3.5 animate-spin rounded-full border-2 border-primary-foreground/30 border-t-primary-foreground"
          />
          {{ $t('providers.addModelButton') }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import type { AvailableImageModel, Provider } from '~/features/providers/composables/useProviders'

const props = defineProps<{
  open: boolean
  provider: Provider | null
}>()

const emit = defineEmits<{
  close: []
  added: []
}>()

const { fetchImageModels, updateProvider } = useProviders()

const search = ref('')
const catalog = ref<AvailableImageModel[]>([])
const loading = ref(false)
const loadError = ref('')
const selected = ref<Set<string>>(new Set())
const saving = ref(false)

const filteredModels = computed(() => {
  const terms = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return catalog.value
  return catalog.value.filter((model) => {
    const haystack = `${model.id} ${model.name}`.toLowerCase()
    return terms.every(term => haystack.includes(term))
  })
})

const canAddCustom = computed(() => {
  const query = search.value.trim()
  if (!query || /\s/.test(query)) return false
  return !catalog.value.some(model => model.id.toLowerCase() === query.toLowerCase())
})

function isAlreadyEnabled(modelId: string): boolean {
  return props.provider?.enabledImageModels?.includes(modelId) ?? false
}

function toggleSelected(modelId: string) {
  if (isAlreadyEnabled(modelId)) return
  const next = new Set(selected.value)
  if (next.has(modelId)) next.delete(modelId)
  else next.add(modelId)
  selected.value = next
}

async function loadCatalog(providerType: string) {
  loading.value = true
  loadError.value = ''
  try {
    catalog.value = await fetchImageModels(providerType)
  } catch (err) {
    loadError.value = (err as Error).message
    catalog.value = []
  } finally {
    loading.value = false
  }
}

async function handleAdd() {
  if (!props.provider || selected.value.size === 0) return
  saving.value = true
  try {
    const current = props.provider.enabledImageModels ?? []
    const enabledImageModels = Array.from(new Set([...current, ...selected.value]))
    const result = await updateProvider(props.provider.id, { enabledImageModels })
    if (result) {
      emit('added')
      emit('close')
    }
  } finally {
    saving.value = false
  }
}

watch(
  () => [props.open, props.provider?.id] as const,
  ([isOpen]) => {
    if (!isOpen || !props.provider) return
    search.value = ''
    selected.value = new Set()
    loadCatalog(props.provider.providerType)
  },
  { immediate: true },
)
</script>
