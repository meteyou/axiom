<script setup lang="ts">
const show = ref(false)

provide('tooltipShow', show)
provide('tooltipOpen', () => { show.value = true })
provide('tooltipClose', () => { show.value = false })
</script>

<template>
  <div class="relative inline-flex">
    <slot />
  </div>
</template>
