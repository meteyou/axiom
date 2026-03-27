<script setup lang="ts">
const open = inject<() => void>('tooltipOpen')
const close = inject<() => void>('tooltipClose')
</script>

<template>
  <div
    class="inline-flex"
    @mouseenter="open?.()"
    @mouseleave="close?.()"
    @focus="open?.()"
    @blur="close?.()"
  >
    <slot />
  </div>
</template>
