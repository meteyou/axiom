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

        <ModelCatalogPicker
          v-model:selected="selected"
          :models="catalog"
          :enabled-ids="provider?.enabledImageModels ?? []"
          :loading="loading"
          :error="loadError"
          :refreshable="isLiveCatalog"
          :allow-custom="preset?.customImageModels !== false"
          @refresh="loadCatalog"
        >
          <template #meta="{ model }">
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
          </template>
        </ModelCatalogPicker>
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

const catalog = ref<AvailableImageModel[]>([])
const loading = ref(false)
const loadError = ref('')
const selected = ref<Set<string>>(new Set())
const saving = ref(false)
const saveError = ref('')

const preset = computed(() => (props.provider ? presets.value[props.provider.providerType] : undefined))
const isLiveCatalog = computed(() => preset.value?.liveImageCatalog === true)

const billingHint = computed(() => {
  switch (preset.value?.imageBilling) {
    case 'estimated': return t('providers.imageModels.billingEstimatedHint')
    case 'subscription': return t('providers.imageModels.billingSubscriptionHint')
    default: return ''
  }
})

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
    selected.value = new Set()
    saveError.value = ''
    loadCatalog()
  },
  { immediate: true },
)
</script>
