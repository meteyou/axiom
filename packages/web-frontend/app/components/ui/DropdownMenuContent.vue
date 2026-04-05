<script setup lang="ts">
import { useElementBounding } from '@vueuse/core'
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
const triggerEl = inject<Ref<HTMLElement | null>>('dropdownMenuTriggerEl')
const contentElRef = inject<Ref<HTMLElement | null>>('dropdownMenuContentEl')

const contentEl = ref<HTMLElement | null>(null)

// Expose content element to parent for click-outside detection
watchEffect(() => {
  if (contentElRef) contentElRef.value = contentEl.value
})

const { left, right, top, bottom, width } = useElementBounding(triggerEl!)

const positionStyle = computed(() => {
  const style: Record<string, string> = {}

  // Vertical
  if (props.side === 'top') {
    style.bottom = `${window.innerHeight - top.value + 6}px`
  } else {
    style.top = `${bottom.value + 6}px`
  }

  // Horizontal
  if (props.align === 'start') {
    style.left = `${left.value}px`
  } else if (props.align === 'center') {
    style.left = `${left.value + width.value / 2}px`
    style.transform = 'translateX(-50%)'
  } else {
    style.right = `${window.innerWidth - right.value}px`
  }

  return style
})

const enterFrom = computed(() =>
  props.side === 'top'
    ? 'opacity-0 scale-95 translate-y-1'
    : 'opacity-0 scale-95 -translate-y-1',
)

const leaveTo = computed(() =>
  props.side === 'top'
    ? 'opacity-0 scale-95 translate-y-1'
    : 'opacity-0 scale-95 -translate-y-1',
)
</script>

<template>
  <Teleport to="body">
    <Transition
      enter-active-class="transition-all duration-150 ease-out"
      :enter-from-class="enterFrom"
      enter-to-class="opacity-100 scale-100 translate-y-0"
      leave-active-class="transition-all duration-100 ease-in"
      leave-from-class="opacity-100 scale-100 translate-y-0"
      :leave-to-class="leaveTo"
    >
      <div
        v-if="open"
        ref="contentEl"
        :class="cn(
          'fixed z-[100] min-w-[160px] overflow-hidden rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg',
          props.class
        )"
        :style="positionStyle"
        role="menu"
        @click.stop
      >
        <slot />
      </div>
    </Transition>
  </Teleport>
</template>
