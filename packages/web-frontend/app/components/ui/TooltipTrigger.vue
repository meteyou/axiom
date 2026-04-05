<script setup lang="ts">
const open = inject<() => void>('tooltipOpen')
const close = inject<() => void>('tooltipClose')
const triggerEl = inject<Ref<HTMLElement | null>>('tooltipTriggerEl')

const el = ref<HTMLElement | null>(null)

watch(el, (value) => {
  if (triggerEl) triggerEl.value = value
}, { immediate: true })
</script>

<template>
  <div
    ref="el"
    class="inline-flex"
    @mouseenter="open?.()"
    @mouseleave="close?.()"
    @focus="open?.()"
    @blur="close?.()"
  >
    <slot />
  </div>
</template>
