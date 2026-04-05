<script setup lang="ts">
const show = ref(false)
const triggerEl = ref<HTMLElement | null>(null)

provide('tooltipShow', show)
provide('tooltipOpen', () => { show.value = true })
provide('tooltipClose', () => { show.value = false })
provide('tooltipTriggerEl', triggerEl)
</script>

<template>
  <div class="relative inline-flex">
    <slot />
  </div>
</template>
