<script setup lang="ts">
import { cn } from '~/lib/utils'
import { useElementBounding } from '@vueuse/core'

const props = defineProps<{
  class?: string
}>()

const subOpen = ref(false)
const triggerEl = ref<HTMLElement | null>(null)
const parentClose = inject<() => void>('dropdownMenuClose')

// Sub-items that call close should close both sub and parent
provide('dropdownMenuClose', () => {
  subOpen.value = false
  parentClose?.()
})

const { right, top } = useElementBounding(triggerEl)

// Close submenu when clicking outside
function onDocumentClick(e: MouseEvent) {
  if (triggerEl.value && !triggerEl.value.contains(e.target as Node)) {
    subOpen.value = false
  }
}

watchEffect(() => {
  if (subOpen.value) {
    document.addEventListener('click', onDocumentClick, true)
  } else {
    document.removeEventListener('click', onDocumentClick, true)
  }
})

onUnmounted(() => {
  document.removeEventListener('click', onDocumentClick, true)
})
</script>

<template>
  <div ref="triggerEl">
    <!-- Trigger item -->
    <button
      type="button"
      role="menuitem"
      aria-haspopup="true"
      :aria-expanded="subOpen"
      :class="cn(
        'flex w-full cursor-default select-none items-center gap-2 rounded-md px-3 py-2 text-sm outline-none transition-colors',
        'hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground',
        props.class
      )"
      @click.stop="subOpen = !subOpen"
    >
      <slot name="trigger" />
      <AppIcon name="chevronRight" size="sm" class="ml-auto text-muted-foreground" />
    </button>

    <!-- Submenu teleported to body to avoid overflow clipping -->
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
          v-if="subOpen"
          class="fixed z-[100] min-w-[160px] overflow-hidden rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg"
          :style="{ left: `${right + 4}px`, top: `${top}px` }"
          role="menu"
          @click.stop
        >
          <slot />
        </div>
      </Transition>
    </Teleport>
  </div>
</template>
