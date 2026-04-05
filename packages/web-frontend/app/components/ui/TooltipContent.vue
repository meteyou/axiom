<script setup lang="ts">
import { cn } from '~/lib/utils'

const props = withDefaults(defineProps<{
  side?: 'top' | 'bottom' | 'left' | 'right'
  class?: string
}>(), {
  side: 'top',
})

const show = inject<Ref<boolean>>('tooltipShow')
const triggerEl = inject<Ref<HTMLElement | null>>('tooltipTriggerEl')

const style = ref<Record<string, string>>({})

function updatePosition() {
  if (!triggerEl?.value) return
  const rect = triggerEl.value.getBoundingClientRect()
  const gap = 6

  switch (props.side) {
    case 'bottom':
      style.value = {
        top: `${rect.bottom + gap}px`,
        left: `${rect.left + rect.width / 2}px`,
        transform: 'translateX(-50%)',
      }
      break
    case 'left':
      style.value = {
        top: `${rect.top + rect.height / 2}px`,
        left: `${rect.left - gap}px`,
        transform: 'translate(-100%, -50%)',
      }
      break
    case 'right':
      style.value = {
        top: `${rect.top + rect.height / 2}px`,
        left: `${rect.right + gap}px`,
        transform: 'translateY(-50%)',
      }
      break
    default: // top
      style.value = {
        top: `${rect.top - gap}px`,
        left: `${rect.left + rect.width / 2}px`,
        transform: 'translate(-50%, -100%)',
      }
      break
  }
}

watch(() => show?.value, (val) => {
  if (val) nextTick(updatePosition)
})
</script>

<template>
  <Teleport to="body">
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
          'fixed z-[9999] w-max max-w-[200px] rounded-md bg-foreground px-2.5 py-1.5 text-xs text-background shadow-md pointer-events-none',
          props.class
        )"
        :style="style"
        role="tooltip"
      >
        <slot />
      </div>
    </Transition>
  </Teleport>
</template>
