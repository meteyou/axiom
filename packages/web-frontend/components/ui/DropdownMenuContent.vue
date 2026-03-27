<script setup lang="ts">
import { cn } from '~/lib/utils'

const props = withDefaults(defineProps<{
  align?: 'start' | 'end' | 'center'
  side?: 'bottom' | 'top'
  class?: string
}>(), {
  align: 'end',
  side: 'bottom',
})

const open = inject<Ref<boolean>>('dropdownMenuOpen')

const alignClass = computed(() => {
  switch (props.align) {
    case 'start': return 'left-0'
    case 'center': return 'left-1/2 -translate-x-1/2'
    default: return 'right-0'
  }
})

const sideClass = computed(() => {
  return props.side === 'top' ? 'bottom-full mb-1.5' : 'top-full mt-1.5'
})

const enterFrom = computed(() =>
  props.side === 'top'
    ? 'opacity-0 scale-95 translate-y-1'
    : 'opacity-0 scale-95 -translate-y-1',
)

const leaveeTo = computed(() =>
  props.side === 'top'
    ? 'opacity-0 scale-95 translate-y-1'
    : 'opacity-0 scale-95 -translate-y-1',
)
</script>

<template>
  <Transition
    enter-active-class="transition-all duration-150 ease-out"
    :enter-from-class="enterFrom"
    enter-to-class="opacity-100 scale-100 translate-y-0"
    leave-active-class="transition-all duration-100 ease-in"
    leave-from-class="opacity-100 scale-100 translate-y-0"
    :leave-to-class="leaveeTo"
  >
    <div
      v-if="open"
      :class="cn(
        'absolute z-50 min-w-[160px] overflow-hidden rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg',
        sideClass,
        alignClass,
        props.class
      )"
      role="menu"
    >
      <slot />
    </div>
  </Transition>
</template>
