<script setup lang="ts">
import { useEventListener } from '@vueuse/core'
import { cn } from '~/lib/utils'

const props = defineProps<{ class?: string }>()

const open = ref(false)
const menuEl = ref<HTMLElement | null>(null)
const triggerEl = ref<HTMLElement | null>(null)
const contentEl = ref<HTMLElement | null>(null)

provide('dropdownMenuOpen', open)
provide('dropdownMenuClose', () => { open.value = false })
provide('dropdownMenuToggle', () => { open.value = !open.value })
provide('dropdownMenuTriggerEl', triggerEl)
provide('dropdownMenuContentEl', contentEl)

useEventListener('click', (e: MouseEvent) => {
  const target = e.target as Node
  // Close if click is outside both the trigger area and the teleported content
  const insideTrigger = menuEl.value?.contains(target)
  const insideContent = contentEl.value?.contains(target)
  if (!insideTrigger && !insideContent) {
    open.value = false
  }
})
</script>

<template>
  <div ref="menuEl" :class="cn('relative inline-block', props.class)">
    <slot />
  </div>
</template>
