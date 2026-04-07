<script setup lang="ts">
interface Props {
  title: string
  subtitle?: string
}

defineProps<Props>()
</script>

<template>
  <div class="shrink-0 border-b border-border px-4 py-3 sm:px-6 sm:py-4">
    <div class="flex items-center justify-between gap-4">
      <div class="min-w-0">
        <h1 class="text-2xl font-bold tracking-tight text-foreground">{{ title }}</h1>
        <p v-if="subtitle" class="mt-1 text-sm text-muted-foreground">{{ subtitle }}</p>
      </div>
      <div v-if="$slots.actions" class="flex shrink-0 items-center gap-2">
        <slot name="actions" />
      </div>
    </div>
  </div>
</template>
