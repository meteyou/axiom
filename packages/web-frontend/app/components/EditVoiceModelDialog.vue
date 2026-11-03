<template>
  <Dialog :open="open" @update:open="(v: boolean) => { if (!v) emit('close') }">
    <DialogContent class="max-w-lg">
      <DialogHeader>
        <DialogTitle>{{ $t(`providers.voiceModels.${kind}.editDialogTitle`) }}</DialogTitle>
        <DialogDescription>
          {{ $t('providers.voiceModels.editDialogDescription') }}
        </DialogDescription>
      </DialogHeader>

      <div v-if="provider && modelId" class="flex flex-col gap-4">
        <div class="flex min-w-0 flex-col gap-0.5">
          <span class="text-sm font-medium text-foreground">{{ provider.name }}</span>
          <span class="truncate font-mono text-xs text-muted-foreground">{{ modelId }}</span>
        </div>

        <div class="flex flex-col gap-1.5">
          <Label for="voice-model-name">{{ $t('providers.editModelNameLabel') }}</Label>
          <Input id="voice-model-name" v-model="name" type="text" :placeholder="modelId" class="text-sm" />
        </div>

        <div class="flex flex-col gap-1.5">
          <Label for="voice-model-price">{{ $t(`providers.voiceModels.${kind}.priceLabel`) }}</Label>
          <Input
            id="voice-model-price"
            v-model="price"
            type="number"
            min="0"
            step="any"
            inputmode="decimal"
            :placeholder="$t('providers.voiceModels.pricePlaceholder')"
            class="text-sm tabular-nums"
          />
          <p class="text-xs text-muted-foreground">{{ $t(`providers.voiceModels.${kind}.priceHint`) }}</p>
          <p v-if="priceError" class="text-xs text-destructive">{{ priceError }}</p>
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" :disabled="saving" @click="emit('close')">
          {{ $t('providers.cancel') }}
        </Button>
        <Button :disabled="saving" @click="handleSave">
          {{ $t('providers.editModelSave') }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import type { Provider } from '~/features/providers/composables/useProviders'
import type { VoiceModelKind } from '~/utils/providerModelOptions'
import { fromVoicePriceInput, toVoicePriceInput } from '~/utils/modelFormat'

const props = defineProps<{
  open: boolean
  provider: Provider | null
  kind: VoiceModelKind
  modelId: string | null
}>()

const emit = defineEmits<{
  close: []
  saved: []
}>()

const { t } = useI18n()
const { updateProviderModel } = useProviders()

const name = ref('')
const price = ref<string | number>('')
const priceError = ref('')
const saving = ref(false)

async function handleSave() {
  if (!props.provider || !props.modelId) return
  priceError.value = ''
  const raw = String(price.value ?? '').trim()
  const value = raw === '' ? null : Number(raw)
  if (value !== null && (!Number.isFinite(value) || value < 0)) {
    priceError.value = t('providers.voiceModels.priceInvalid')
    return
  }

  saving.value = true
  try {
    const result = await updateProviderModel(props.provider.id, props.modelId, {
      name: name.value,
      cost: { input: value === null ? null : fromVoicePriceInput(props.kind, value) },
    })
    if (result) {
      emit('saved')
      emit('close')
    }
  } finally {
    saving.value = false
  }
}

watch(
  () => [props.open, props.provider?.id, props.modelId] as const,
  ([isOpen]) => {
    if (!isOpen || !props.provider || !props.modelId) return
    const entry = props.provider.models?.find(m => m.id === props.modelId)
    name.value = entry?.name ?? ''
    const stored = entry?.cost?.input
    price.value = stored !== undefined ? toVoicePriceInput(props.kind, stored) : ''
    priceError.value = ''
  },
  { immediate: true },
)
</script>
