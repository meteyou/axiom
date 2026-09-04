<template>
  <div class="rounded-lg border border-border bg-card">
    <button
      class="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm transition-colors hover:bg-muted/50"
      @click="$emit('toggle')"
    >
      <AppIcon :name="icon" size="sm" :class="iconClass ?? 'text-muted-foreground'" />
      <slot name="header" />
      <span class="flex-1" />
      <span v-if="timestamp" class="text-xs text-muted-foreground">
        {{ timestamp }}
      </span>
      <AppIcon
        :name="expanded ? 'chevronDown' : 'chevronRight'"
        size="sm"
        class="text-muted-foreground"
      />
    </button>

    <div v-if="expanded" class="border-t border-border bg-muted/20 px-4 py-3">
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  icon: string
  iconClass?: string
  timestamp?: string
  expanded: boolean
}>()

defineEmits<{
  toggle: []
}>()
</script>
