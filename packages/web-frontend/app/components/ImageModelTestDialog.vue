<template>
  <Dialog :open="open" @update:open="(v: boolean) => { if (!v && !running) emit('close') }">
    <DialogContent class="max-w-md">
      <DialogHeader>
        <DialogTitle>{{ $t('providers.imageModels.testImageTitle') }}</DialogTitle>
        <DialogDescription class="font-mono text-xs">
          {{ provider?.name }} · {{ modelId }}
        </DialogDescription>
      </DialogHeader>

      <div class="flex flex-col gap-3">
        <Alert v-if="!result" variant="warning">
          <AlertDescription v-if="billing === 'subscription'" class="flex flex-col gap-1 text-sm">
            <span class="font-medium">{{ $t('providers.imageModels.testImageSubscriptionWarning') }}</span>
            <span>{{ $t('providers.imageModels.testImageSubscriptionDetail') }}</span>
          </AlertDescription>
          <AlertDescription v-else class="flex flex-col gap-1 text-sm">
            <span class="font-medium">{{ $t('providers.imageModels.testImageCostWarning') }}</span>
            <span>{{ $t('providers.imageModels.testImageCostDetail') }}</span>
          </AlertDescription>
        </Alert>

        <div v-if="running" class="flex items-center gap-2 py-4 text-xs text-muted-foreground">
          <span class="h-3 w-3 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
          {{ $t('providers.imageModels.testImageRunning') }}
        </div>

        <template v-if="result">
          <img
            v-if="result.success && result.dataUrl"
            :src="result.dataUrl"
            :alt="$t('providers.imageModels.testImageAlt')"
            class="max-h-80 w-full rounded-md border border-border bg-muted object-contain"
          >
          <p v-else class="break-words text-sm text-destructive">{{ result.error }}</p>
          <div class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>{{ $t('providers.imageModels.testImageCost', { cost: formatCost(result) }) }}</span>
            <span v-if="result.durationMs !== undefined">{{ $t('providers.imageModels.testImageDuration', { seconds: (result.durationMs / 1000).toFixed(1) }) }}</span>
            <span v-if="result.mimeType" class="font-mono">{{ result.mimeType }}</span>
          </div>
          <ul v-if="result.notes?.length || result.usageNote" class="flex flex-col gap-0.5 text-xs text-muted-foreground">
            <li v-for="note in result.notes ?? []" :key="note">{{ note }}</li>
            <li v-if="result.usageNote">{{ result.usageNote }}</li>
          </ul>
        </template>
      </div>

      <DialogFooter>
        <Button variant="outline" :disabled="running" @click="emit('close')">
          {{ result ? $t('common.close') : $t('providers.cancel') }}
        </Button>
        <Button v-if="!result" :disabled="running" @click="handleGenerate">
          {{ billing === 'subscription' ? $t('providers.imageModels.testImageConfirmSubscription') : $t('providers.imageModels.testImageConfirm') }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import type { Provider, ProviderImageTestResult } from '~/features/providers/composables/useProviders'

const props = defineProps<{
  open: boolean
  provider: Provider | null
  modelId: string | null
}>()

const emit = defineEmits<{
  close: []
}>()

const { t } = useI18n()
const { generateTestImage, presets } = useProviders()

const running = ref(false)
const result = ref<ProviderImageTestResult | null>(null)

const billing = computed(() => (props.provider ? presets.value[props.provider.providerType]?.imageBilling : undefined))

function formatCost(outcome: ProviderImageTestResult): string {
  const resultBilling = outcome.billing ?? billing.value
  if (resultBilling === 'subscription') return t('providers.imageModels.costSubscription')
  if (outcome.costUsd === null) return t('providers.imageModels.costNotReported')
  const amount = `$${outcome.costUsd.toFixed(4)}`
  return resultBilling === 'estimated' ? t('providers.imageModels.costEstimatedAmount', { cost: amount }) : amount
}

async function handleGenerate() {
  if (!props.provider || !props.modelId) return
  running.value = true
  try {
    result.value = await generateTestImage(props.provider.id, props.modelId)
  } finally {
    running.value = false
  }
}

watch(
  () => [props.open, props.provider?.id, props.modelId] as const,
  ([isOpen]) => {
    if (isOpen) result.value = null
  },
)
</script>
