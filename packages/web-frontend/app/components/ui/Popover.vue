<script setup lang="ts">
const props = withDefaults(defineProps<{
  align?: 'start' | 'center' | 'end'
}>(), {
  align: 'end',
})

const open = defineModel<boolean>('open', { default: false })
const triggerRef = ref<HTMLElement | null>(null)
const contentRef = ref<HTMLElement | null>(null)

function toggle() {
  open.value = !open.value
}

function onClickOutside(e: MouseEvent) {
  if (!open.value) return
  const target = e.target as Node
  if (triggerRef.value?.contains(target) || contentRef.value?.contains(target)) return
  open.value = false
}

const popoverStyle = ref<Record<string, string>>({})

function updatePosition() {
  if (!triggerRef.value) return
  const rect = triggerRef.value.getBoundingClientRect()
  const style: Record<string, string> = {
    top: `${rect.bottom + 4}px`,
  }
  if (props.align === 'end') {
    style.right = `${window.innerWidth - rect.right}px`
  } else if (props.align === 'start') {
    style.left = `${rect.left}px`
  } else {
    style.left = `${rect.left + rect.width / 2}px`
    style.transform = 'translateX(-50%)'
  }
  popoverStyle.value = style
}

watch(open, (val) => {
  if (val) nextTick(updatePosition)
})

onMounted(() => document.addEventListener('mousedown', onClickOutside))
onUnmounted(() => document.removeEventListener('mousedown', onClickOutside))
</script>

<template>
  <div class="relative inline-flex">
    <div ref="triggerRef" @click="toggle">
      <slot name="trigger" />
    </div>

    <Teleport to="body">
      <Transition
        enter-active-class="transition duration-100 ease-out"
        enter-from-class="opacity-0 scale-95"
        enter-to-class="opacity-100 scale-100"
        leave-active-class="transition duration-75 ease-in"
        leave-from-class="opacity-100 scale-100"
        leave-to-class="opacity-0 scale-95"
      >
        <div
          v-if="open"
          ref="contentRef"
          class="fixed z-50 rounded-md border border-border bg-popover p-4 text-popover-foreground shadow-md outline-none"
          :style="popoverStyle"
        >
          <slot />
        </div>
      </Transition>
    </Teleport>
  </div>
</template>
