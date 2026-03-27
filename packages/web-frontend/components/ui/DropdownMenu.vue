<script setup lang="ts">
import { useEventListener } from '@vueuse/core'

const open = ref(false)
const menuEl = ref<HTMLElement | null>(null)

provide('dropdownMenuOpen', open)
provide('dropdownMenuClose', () => { open.value = false })
provide('dropdownMenuToggle', () => { open.value = !open.value })

useEventListener('click', (e: MouseEvent) => {
  if (menuEl.value && !menuEl.value.contains(e.target as Node)) {
    open.value = false
  }
})
</script>

<template>
  <div ref="menuEl" class="relative inline-block">
    <slot />
  </div>
</template>
