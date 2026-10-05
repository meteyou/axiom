<template>
  <Dialog :open="open" @update:open="(v: boolean) => { if (!v) emit('close') }">
    <DialogContent class="max-w-lg">
      <DialogHeader>
        <DialogTitle>{{ $t('providers.imageModels.editDialogTitle') }}</DialogTitle>
        <DialogDescription>
          {{ $t('providers.imageModels.editDialogDescription') }}
        </DialogDescription>
      </DialogHeader>

      <div v-if="provider && modelId" class="flex flex-col gap-4">
        <div class="flex min-w-0 flex-col gap-0.5">
          <span class="text-sm font-medium text-foreground">{{ provider.name }}</span>
          <span class="truncate font-mono text-xs text-muted-foreground">{{ modelId }}</span>
        </div>

        <div class="flex flex-col gap-1.5">
          <Label for="image-model-name">{{ $t('providers.editModelNameLabel') }}</Label>
          <Input
            id="image-model-name"
            v-model="name"
            type="text"
            :placeholder="provider.imageModelSpecs?.[modelId]?.name ?? modelId"
            class="text-sm"
          />
        </div>

        <div class="flex flex-col gap-1.5">
          <Label for="image-model-description">{{ $t('providers.editModelDescriptionLabel') }}</Label>
          <textarea
            id="image-model-description"
            v-model="description"
            rows="3"
            class="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            :placeholder="$t('providers.imageModels.descriptionPlaceholder')"
          />
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

const props = defineProps<{
  open: boolean
  provider: Provider | null
  modelId: string | null
}>()

const emit = defineEmits<{
  close: []
  saved: []
}>()

const { updateProviderModel } = useProviders()

const name = ref('')
const description = ref('')
const saving = ref(false)

async function handleSave() {
  if (!props.provider || !props.modelId) return
  saving.value = true
  try {
    const result = await updateProviderModel(props.provider.id, props.modelId, {
      name: name.value,
      description: description.value,
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
    description.value = entry?.description ?? ''
  },
  { immediate: true },
)
</script>
