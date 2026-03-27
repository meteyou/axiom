<script setup lang="ts">
import { cn } from '~/lib/utils'

const props = defineProps<{
  class?: string
  destructive?: boolean
  disabled?: boolean
}>()

const close = inject<() => void>('dropdownMenuClose')

function handleClick() {
  if (!props.disabled) {
    close?.()
  }
}
</script>

<template>
  <button
    type="button"
    role="menuitem"
    :disabled="disabled"
    :class="cn(
      'flex w-full cursor-default select-none items-center gap-2 rounded-md px-3 py-2 text-sm outline-none transition-colors',
      'hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground',
      destructive && 'text-destructive hover:bg-destructive/10 focus:bg-destructive/10',
      disabled && 'pointer-events-none opacity-50',
      props.class
    )"
    @click="handleClick"
  >
    <slot />
  </button>
</template>
