<template>
  <Dialog :open="open" @update:open="(v: boolean) => { if (!v) emit('close') }">
    <DialogContent class="max-w-md">
      <DialogHeader>
        <DialogTitle>{{ $t(`providers.voiceModels.${kind}.addDialogTitle`) }}</DialogTitle>
        <DialogDescription>
          {{ $t(`providers.voiceModels.${kind}.addDialogDescription`) }}
        </DialogDescription>
      </DialogHeader>

      <div class="flex flex-col gap-3">
        <ModelCatalogPicker
          v-model:selected="selected"
          :models="catalog"
          :enabled-ids="currentModels"
          :loading="loading"
          :error="loadError"
          refreshable
          :allow-custom="provider ? presets[provider.providerType]?.customVoiceModels !== false : false"
          :search-text="searchText"
          @refresh="loadCatalog"
        >
          <template #subtitle="{ model }">
            {{ model.id }}<template v-if="model.languages?.length"> · {{ formatLanguages(model.languages) }}</template>
          </template>
          <template #meta="{ model }">
            <span v-if="model.costPerMillion !== undefined" class="text-[10px] tabular-nums text-muted-foreground">
              {{ formatVoiceModelPrice(kind, model.costPerMillion) }}
            </span>
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
import type { AvailableVoiceModel, Provider, VoiceModelKind } from '~/features/providers/composables/useProviders'
import { useProvidersApi } from '~/api/providers'
import { getVoiceModelIds } from '~/utils/providerModelOptions'
import { formatVoiceModelPrice } from '~/utils/modelFormat'

const props = defineProps<{
  open: boolean
  provider: Provider | null
  kind: VoiceModelKind
}>()

const emit = defineEmits<{
  close: []
  added: []
}>()

const { fetchLiveVoiceModels, fetchProviders, updateProvider, presets } = useProviders()
const providersApi = useProvidersApi()

const catalog = ref<AvailableVoiceModel[]>([])
const loading = ref(false)
const loadError = ref('')
const selected = ref<Set<string>>(new Set())
const saving = ref(false)
const saveError = ref('')

function searchText(model: AvailableVoiceModel): string {
  return `${model.description ?? ''} ${(model.languages ?? []).join(' ')}`
}

const MAX_LANGUAGES = 4

function formatLanguages(languages: string[]): string {
  const bases = [...new Set(languages.map(language => language.split('-')[0] ?? language))]
  return bases.length <= MAX_LANGUAGES ? bases.join(', ') : `${bases.slice(0, MAX_LANGUAGES).join(', ')} +${bases.length - MAX_LANGUAGES}`
}

const currentModels = computed(() => (props.provider ? getVoiceModelIds(props.provider, props.kind) : []))

async function loadCatalog() {
  if (!props.provider) return
  loading.value = true
  loadError.value = ''
  try {
    catalog.value = await fetchLiveVoiceModels(props.provider.id, props.kind)
  } catch (err) {
    loadError.value = (err as Error).message
    catalog.value = []
  } finally {
    loading.value = false
  }
}

// Display names and prices come only from the live list, so they are stored per model.
async function persistCatalogDetails(provider: Provider, modelIds: string[]) {
  const patches = catalog.value
    .filter(entry => modelIds.includes(entry.id))
    .map(entry => ({
      id: entry.id,
      patch: {
        ...(entry.name && entry.name !== entry.id && { name: entry.name }),
        ...(entry.costPerMillion !== undefined && { cost: { input: entry.costPerMillion } }),
      },
    }))
    .filter(({ patch }) => Object.keys(patch).length > 0)
  if (patches.length === 0) return
  await Promise.all(patches.map(({ id, patch }) => providersApi.updateProviderModel(provider.id, id, patch)))
  await fetchProviders()
}

async function handleAdd() {
  if (!props.provider || selected.value.size === 0) return
  saving.value = true
  saveError.value = ''
  try {
    const current = currentModels.value
    const added = Array.from(selected.value).filter(id => !current.includes(id))
    const models = Array.from(new Set([...current, ...added]))
    const result = await updateProvider(
      props.provider.id,
      props.kind === 'stt' ? { enabledSttModels: models } : { enabledTtsModels: models },
    )
    if (!result) return
    try {
      await persistCatalogDetails(props.provider, added)
    } catch (err) {
      saveError.value = (err as Error).message
      return
    }
    emit('added')
    emit('close')
  } finally {
    saving.value = false
  }
}

watch(
  () => [props.open, props.provider?.id, props.kind] as const,
  ([isOpen]) => {
    if (!isOpen || !props.provider) return
    selected.value = new Set()
    saveError.value = ''
    catalog.value = []
    loadCatalog()
  },
  { immediate: true },
)
</script>
