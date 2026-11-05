<template>
  <div class="flex flex-col gap-3">
    <div class="flex items-center gap-2">
      <Input
        v-model="search"
        type="text"
        class="flex-1"
        :placeholder="$t('providers.addModelSearch')"
        autofocus
      />
      <Button
        v-if="refreshable"
        type="button"
        variant="outline"
        size="icon"
        class="shrink-0"
        :disabled="loading"
        :title="$t('providers.addModelRefresh')"
        :aria-label="$t('providers.addModelRefresh')"
        @click="emit('refresh')"
      >
        <AppIcon name="refresh" :class="['h-4 w-4', loading ? 'animate-spin' : '']" />
      </Button>
    </div>

    <div v-if="loading" class="flex items-center gap-2 py-4 text-xs text-muted-foreground">
      <span class="h-3 w-3 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
      {{ $t('providers.loadingModels') }}
    </div>

    <div v-if="view.showError" class="flex flex-col gap-1">
      <span class="text-xs text-destructive">{{ $t('providers.modelsLoadError') }}</span>
      <span class="break-words text-xs text-muted-foreground">{{ error }}</span>
      <button
        type="button"
        class="self-start text-xs text-destructive hover:underline"
        @click="emit('refresh')"
      >
        {{ $t('providers.modelsRetry') }}
      </button>
      <span v-if="view.showCustomHint" class="text-xs text-muted-foreground">
        {{ $t('providers.addModelCustomHint') }}
      </span>
    </div>

    <div v-if="view.showList" class="flex max-h-72 flex-col gap-0 divide-y divide-border overflow-hidden overflow-y-auto rounded-md border border-border">
      <label
        v-for="model in filteredModels"
        :key="model.id"
        :class="[
          'flex items-center gap-3 px-3 py-2 text-sm transition-colors',
          isEnabled(model.id) ? 'opacity-50' : 'cursor-pointer hover:bg-accent/50',
          selected.has(model.id) ? 'bg-accent/30' : '',
        ]"
      >
        <input
          type="checkbox"
          :checked="selected.has(model.id)"
          :disabled="isEnabled(model.id)"
          class="h-4 w-4 rounded border-border text-primary focus:ring-primary"
          @change="toggle(model.id)"
        >
        <span class="flex min-w-0 flex-1 flex-col">
          <span class="truncate">{{ model.name }}</span>
          <span class="truncate font-mono text-[10px] text-muted-foreground">
            <slot name="subtitle" :model="model">{{ model.id }}</slot>
          </span>
        </span>
        <span v-if="$slots.meta || isEnabled(model.id)" class="flex shrink-0 flex-col items-end gap-0.5">
          <slot name="meta" :model="model" />
          <span v-if="isEnabled(model.id)" class="text-[10px] text-muted-foreground">
            {{ $t('providers.addModelAlreadyEnabled') }}
          </span>
        </span>
      </label>

      <div v-if="view.showEmpty" class="px-3 py-4 text-xs text-muted-foreground">
        {{ $t('providers.addModelEmpty') }}
      </div>

      <button
        v-if="view.customId"
        type="button"
        :class="[
          'flex items-center gap-3 px-3 py-2 text-left text-sm transition-colors hover:bg-accent/50',
          selected.has(customId) ? 'bg-accent/30' : '',
        ]"
        @click="toggle(customId)"
      >
        <span class="flex h-4 w-4 items-center justify-center rounded border border-primary text-primary">
          <AppIcon v-if="selected.has(customId)" name="check" class="h-3 w-3" />
          <span v-else class="text-xs leading-none">+</span>
        </span>
        <span class="flex min-w-0 flex-1 flex-col">
          <span class="truncate">{{ $t('providers.addModelCustom', { name: customId }) }}</span>
          <span class="truncate font-mono text-[10px] text-muted-foreground">{{ customId }}</span>
        </span>
      </button>
    </div>

    <p v-if="selected.size > 0" class="text-xs text-muted-foreground">
      {{ $t('providers.addModelSelected', { count: selected.size }) }}
    </p>
  </div>
</template>

<script setup lang="ts" generic="T extends { id: string; name: string }">
import { getModelCatalogPickerView } from '~/utils/modelCatalogPicker'

const props = withDefaults(defineProps<{
  models: T[]
  /** Ids already configured on the provider; shown greyed out and not selectable. */
  enabledIds: string[]
  loading?: boolean
  error?: string
  refreshable?: boolean
  /** Offer the typed search text as a model id when nothing matches. */
  allowCustom?: boolean
  /** Extra text the search matches besides id and name. */
  searchText?: (model: T) => string
}>(), {
  loading: false,
  error: '',
  refreshable: false,
  allowCustom: false,
  searchText: undefined,
})

const emit = defineEmits<{
  refresh: []
}>()

const selected = defineModel<Set<string>>('selected', { required: true })

const search = ref('')

const filteredModels = computed(() => {
  const terms = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return props.models
  return props.models.filter((model) => {
    const haystack = `${model.id} ${model.name} ${props.searchText?.(model) ?? ''}`.toLowerCase()
    return terms.every(term => haystack.includes(term))
  })
})

const view = computed(() => getModelCatalogPickerView({
  models: props.models,
  filteredCount: filteredModels.value.length,
  query: search.value,
  loading: props.loading,
  error: props.error,
  allowCustom: props.allowCustom,
}))
const customId = computed(() => view.value.customId)

function isEnabled(modelId: string): boolean {
  return props.enabledIds.includes(modelId)
}

function toggle(modelId: string) {
  if (isEnabled(modelId)) return
  const next = new Set(selected.value)
  if (next.has(modelId)) next.delete(modelId)
  else next.add(modelId)
  selected.value = next
}
</script>
