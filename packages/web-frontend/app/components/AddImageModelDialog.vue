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
        <p v-if="billingHint" class="text-xs text-muted-foreground">
          {{ billingHint }}
        </p>

        <div class="flex items-center gap-2">
          <Input
            v-model="search"
            type="text"
            class="flex-1"
            :placeholder="$t('providers.addModelSearch')"
            autofocus
          />
          <Button
            v-if="isLiveCatalog"
            type="button"
            variant="outline"
            size="icon"
            class="shrink-0"
            :disabled="loading"
            :title="$t('providers.addModelRefresh')"
            :aria-label="$t('providers.addModelRefresh')"
            @click="loadCatalog"
          >
            <AppIcon name="refresh" :class="['h-4 w-4', loading ? 'animate-spin' : '']" />
          </Button>
        </div>

        <div v-if="loading" class="flex items-center gap-2 py-4 text-xs text-muted-foreground">
          <span class="h-3 w-3 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
          {{ $t('providers.loadingModels') }}
        </div>

        <div v-else-if="loadError" class="flex flex-col gap-1">
          <span class="text-xs text-destructive">{{ $t('providers.modelsLoadError') }}</span>
          <span class="break-words text-xs text-muted-foreground">{{ loadError }}</span>
          <button
            type="button"
            class="self-start text-xs text-destructive hover:underline"
            @click="loadCatalog"
          >
            {{ $t('providers.modelsRetry') }}
          </button>
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
            <span
              v-if="model.pricing || !model.input.includes('image') || isAlreadyEnabled(model.id)"
              class="flex shrink-0 flex-col items-end gap-0.5"
            >
              <span
                v-if="model.pricing"
                class="text-[10px] tabular-nums text-muted-foreground"
                :title="$t('providers.imageModels.priceHint')"
              >
                {{ $t('providers.imageModels.pricePerMillion', { price: formatPerMillionPrice(model.pricing.imageOutput) }) }}
              </span>
              <Badge
                v-if="!model.input.includes('image')"
                variant="outline"
                class="px-1.5 py-0 text-[10px]"
                :title="$t('providers.imageModels.noImageInputHint')"
              >
                {{ $t('providers.imageModels.noImageInput') }}
              </Badge>
              <span v-if="isAlreadyEnabled(model.id)" class="text-[10px] text-muted-foreground">
                {{ $t('providers.addModelAlreadyEnabled') }}
              </span>
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
        <p v-if="saveError" class="break-words text-xs text-destructive">{{ saveError }}</p>
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
import { useProvidersApi } from '~/api/providers'
import { buildImageCatalogModelPatch, formatPerMillionPrice } from '~/utils/imageModelCatalog'

const props = defineProps<{
  open: boolean
  provider: Provider | null
}>()

const emit = defineEmits<{
  close: []
  added: []
}>()

const { fetchImageModels, fetchLiveImageModels, updateProvider, presets } = useProviders()
const providersApi = useProvidersApi()
const { t } = useI18n()

const search = ref('')
const catalog = ref<AvailableImageModel[]>([])
const loading = ref(false)
const loadError = ref('')
const selected = ref<Set<string>>(new Set())
const saving = ref(false)
const saveError = ref('')

const filteredModels = computed(() => {
  const terms = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return catalog.value
  return catalog.value.filter((model) => {
    const haystack = `${model.id} ${model.name}`.toLowerCase()
    return terms.every(term => haystack.includes(term))
  })
})

const preset = computed(() => (props.provider ? presets.value[props.provider.providerType] : undefined))
const isLiveCatalog = computed(() => preset.value?.liveImageCatalog === true)

const billingHint = computed(() => {
  switch (preset.value?.imageBilling) {
    case 'estimated': return t('providers.imageModels.billingEstimatedHint')
    case 'subscription': return t('providers.imageModels.billingSubscriptionHint')
    default: return ''
  }
})

const canAddCustom = computed(() => {
  if (preset.value?.customImageModels === false) return false
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

async function loadCatalog() {
  if (!props.provider) return
  loading.value = true
  loadError.value = ''
  try {
    catalog.value = isLiveCatalog.value
      ? await fetchLiveImageModels(props.provider.id)
      : await fetchImageModels(props.provider.providerType)
  } catch (err) {
    loadError.value = (err as Error).message
    catalog.value = []
  } finally {
    loading.value = false
  }
}

// Live lists include models newer than the bundled catalog; their name and
// modalities are only known from the list, so they are stored per model.
// Enabling a model without them would build it with default modalities.
async function persistLiveCatalogMetadata(provider: Provider, modelIds: string[]) {
  if (!isLiveCatalog.value) return
  await Promise.all(
    catalog.value
      .filter(entry => modelIds.includes(entry.id))
      .map(entry => providersApi.updateProviderModel(provider.id, entry.id, buildImageCatalogModelPatch(entry))),
  )
}

async function handleAdd() {
  if (!props.provider || selected.value.size === 0) return
  saving.value = true
  saveError.value = ''
  try {
    const current = props.provider.enabledImageModels ?? []
    const added = Array.from(selected.value).filter(id => !current.includes(id))
    const enabledImageModels = Array.from(new Set([...current, ...added]))
    try {
      await persistLiveCatalogMetadata(props.provider, added)
    } catch (err) {
      saveError.value = (err as Error).message
      return
    }
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
    saveError.value = ''
    loadCatalog()
  },
  { immediate: true },
)
</script>
