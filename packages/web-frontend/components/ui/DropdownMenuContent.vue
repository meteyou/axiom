<script setup lang="ts">
import { cn } from '~/lib/utils'

const props = withDefaults(defineProps<{
  align?: 'start' | 'end' | 'center'
  class?: string
}>(), {
  align: 'end',
})

const open = inject<Ref<boolean>>('dropdownMenuOpen')

const alignClass = computed(() => {
  switch (props.align) {
    case 'start': return 'left-0'
    case 'center': return 'left-1/2 -translate-x-1/2'
    default: return 'right-0'
  }
})
</script>

<template>
  <Transition
    enter-active-class="transition-all duration-150 ease-out"
    enter-from-class="opacity-0 scale-95 -translate-y-1"
    enter-to-class="opacity-100 scale-100 translate-y-0"
    leave-active-class="transition-all duration-100 ease-in"
    leave-from-class="opacity-100 scale-100 translate-y-0"
    leave-to-class="opacity-0 scale-95 -translate-y-1"
  >
    <div
      v-if="open"
      :class="cn(
        'absolute top-full mt-1.5 z-50 min-w-[160px] overflow-hidden rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg',
        alignClass,
        props.class
      )"
      role="menu"
    >
      <slot />
    </div>
  </Transition>
</template>
