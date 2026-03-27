<script setup lang="ts">
const toggle = inject<() => void>('dropdownMenuToggle')
const open = inject<Ref<boolean>>('dropdownMenuOpen')
const triggerEl = inject<Ref<HTMLElement | null>>('dropdownMenuTriggerEl')

const el = ref<HTMLElement | null>(null)

// Expose trigger element to parent for positioning
watchEffect(() => {
  if (triggerEl) triggerEl.value = el.value
})
</script>

<template>
  <div
    ref="el"
    role="button"
    :aria-expanded="open"
    aria-haspopup="true"
    class="cursor-pointer"
    @click.stop="toggle?.()"
  >
    <slot />
  </div>
</template>
