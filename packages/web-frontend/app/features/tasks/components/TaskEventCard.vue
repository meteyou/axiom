<template>
  <div class="rounded-lg border border-border bg-card">
    <component
      :is="collapsible ? 'button' : 'div'"
      class="flex w-full items-center gap-3 px-4 text-left text-sm"
      :class="headerClass"
      @click="collapsible && $emit('toggle')"
    >
      <AppIcon :name="icon" size="sm" :class="iconClass ?? 'text-muted-foreground'" />
      <slot name="header" />
      <span class="flex-1" />
      <span v-if="meta || timestamp" class="text-xs text-muted-foreground tabular-nums">
        <template v-if="meta">{{ meta }}</template>
        <span v-if="meta && timestamp" class="mx-1.5 opacity-50">·</span>
        <template v-if="timestamp">{{ timestamp }}</template>
      </span>
      <AppIcon
        v-if="collapsible"
        :name="expanded ? 'chevronDown' : 'chevronRight'"
        size="sm"
        class="text-muted-foreground"
      />
      <!-- Keeps the timestamp column aligned with collapsible cards -->
      <span v-else class="w-3.5" aria-hidden="true" />
    </component>

    <div v-if="collapsible && expanded" class="border-t border-border bg-muted/20 px-4 py-3">
      <slot />
    </div>
    <div v-else-if="!collapsible && hasBody" class="px-4 pb-3 pl-10.5 pt-1">
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{
  icon: string
  iconClass?: string
  timestamp?: string
  meta?: string
  collapsible?: boolean
  expanded?: boolean
}>()

defineEmits<{
  toggle: []
}>()

const slots = useSlots()
const hasBody = computed(() => Boolean(slots.default))

const headerClass = computed(() => {
  if (props.collapsible) return 'py-2.5 transition-colors hover:bg-muted/50'
  return hasBody.value ? 'pt-3' : 'py-2.5'
})
</script>
