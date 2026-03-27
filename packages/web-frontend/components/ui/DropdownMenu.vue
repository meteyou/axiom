<script setup lang="ts">
import { useEventListener } from '@vueuse/core'
import { cn } from '~/lib/utils'

const props = defineProps<{ class?: string }>()

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
  <div ref="menuEl" :class="cn('relative inline-block', props.class)">
    <slot />
  </div>
</template>
