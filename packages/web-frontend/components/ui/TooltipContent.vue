<script setup lang="ts">
import { cn } from '~/lib/utils'

const props = withDefaults(defineProps<{
  side?: 'top' | 'bottom' | 'left' | 'right'
  class?: string
}>(), {
  side: 'top',
})

const show = inject<Ref<boolean>>('tooltipShow')

const positionClass = computed(() => {
  switch (props.side) {
    case 'bottom': return 'top-full mt-1.5 left-1/2 -translate-x-1/2'
    case 'left': return 'right-full mr-1.5 top-1/2 -translate-y-1/2'
    case 'right': return 'left-full ml-1.5 top-1/2 -translate-y-1/2'
    default: return 'bottom-full mb-1.5 left-1/2 -translate-x-1/2'
  }
})
</script>

<template>
  <Transition
    enter-active-class="transition-all duration-150 ease-out"
    enter-from-class="opacity-0 scale-95"
    enter-to-class="opacity-100 scale-100"
    leave-active-class="transition-all duration-100 ease-in"
    leave-from-class="opacity-100 scale-100"
    leave-to-class="opacity-0 scale-95"
  >
    <div
      v-if="show"
      :class="cn(
        'absolute z-50 w-max max-w-[200px] rounded-md bg-foreground px-2.5 py-1.5 text-xs text-background shadow-md',
        positionClass,
        props.class
      )"
      role="tooltip"
    >
      <slot />
    </div>
  </Transition>
</template>
