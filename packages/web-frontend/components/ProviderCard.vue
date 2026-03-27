<template>
  <Card :class="isActive ? 'border-primary ring-1 ring-primary' : ''">
    <CardContent class="p-4">
      <!-- Card header row -->
      <div class="flex flex-wrap items-start justify-between gap-3 sm:flex-nowrap">
        <!-- Provider info -->
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">
            <h3 class="text-base font-semibold text-foreground">{{ provider.name }}</h3>
            <Badge v-if="isActive" variant="default">
              {{ $t('providers.active') }}
            </Badge>
            <Badge :variant="statusBadgeVariant">
              {{ statusLabel }}
            </Badge>
          </div>
          <div class="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <span>{{ typeLabel }}</span>
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
            :disabled="isTesting"
            @click="emit('test')"
          >
            <span
              v-if="isTesting"
              class="mr-1 h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
              aria-hidden="true"
            />
            {{ isTesting ? $t('providers.testing') : $t('providers.testConnection') }}
          </Button>
          <Button
            v-if="!isActive"
            variant="outline"
            size="sm"
            @click="emit('activate')"
          >
            {{ $t('providers.setActive') }}
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            :title="$t('users.edit')"
            :aria-label="$t('users.edit')"
            @click="emit('edit')"
          >
            <AppIcon name="edit" class="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            :disabled="isActive"
            :title="isActive ? $t('providers.cannotDeleteActive') : $t('providers.delete')"
            :aria-label="isActive ? $t('providers.cannotDeleteActive') : $t('providers.delete')"
            class="text-destructive hover:bg-destructive/10 hover:text-destructive border-destructive/30"
            @click="emit('delete')"
          >
            <AppIcon name="trash" class="h-4 w-4" />
          </Button>
        </div>
      </div>

      <!-- Test result feedback -->
      <Alert
        v-if="testResult"
        :variant="testResult.success ? 'success' : 'destructive'"
        class="mt-3"
      >
        <AlertDescription>
          {{ testResult.success ? testResult.message : testResult.error }}
        </AlertDescription>
      </Alert>
    </CardContent>
  </Card>
</template>

<script setup lang="ts">
import type { Provider, ProviderTypePreset } from '~/composables/useProviders'

const { t } = useI18n()

const props = defineProps<{
  provider: Provider
  isActive: boolean
  isTesting: boolean
  testResult?: { success: boolean; message?: string; error?: string } | null
  presets: Record<string, ProviderTypePreset>
}>()

const emit = defineEmits<{
  test: []
  activate: []
  edit: []
  delete: []
}>()

const typeLabel = computed(() => {
  const preset = props.presets[props.provider.providerType]
  return preset?.label ?? props.provider.providerType
})

const statusBadgeVariant = computed<'success' | 'destructive' | 'muted'>(() => {
  switch (props.provider.status) {
    case 'connected': return 'success'
    case 'error': return 'destructive'
    default: return 'muted'
  }
})

const statusLabel = computed(() => {
  switch (props.provider.status) {
    case 'connected': return t('providers.statusConnected')
    case 'error': return t('providers.statusError')
    default: return t('providers.statusUntested')
  }
})
</script>
