<script setup lang="ts">
import { cn } from '~/lib/utils'

interface Props {
  class?: string
}

const props = defineProps<Props>()

const isOpen = inject<ComputedRef<boolean>>('dialog-open', computed(() => false))
const closeDialog = inject<() => void>('dialog-close', () => {})

function handleBackdropClick(e: MouseEvent) {
  if (e.target === e.currentTarget) {
    closeDialog()
  }
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') closeDialog()
}
</script>

<template>
  <Teleport to="body">
    <Transition
      enter-active-class="transition-opacity duration-150"
      enter-from-class="opacity-0"
      enter-to-class="opacity-100"
      leave-active-class="transition-opacity duration-150"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <div
        v-if="isOpen"
        class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
        @click="handleBackdropClick"
        @keydown="handleKeydown"
      >
        <div
          :class="cn(
            'relative z-50 w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-xl',
            'focus:outline-none',
            props.class
          )"
          role="dialog"
          aria-modal="true"
          tabindex="-1"
        >
          <slot />
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
