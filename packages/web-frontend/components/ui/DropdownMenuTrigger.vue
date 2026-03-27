<script setup lang="ts">
const toggle = inject<() => void>('dropdownMenuToggle')
const open = inject<Ref<boolean>>('dropdownMenuOpen')
</script>

<template>
  <div
    role="button"
    :aria-expanded="open"
    aria-haspopup="true"
    class="cursor-pointer"
    @click.stop="toggle?.()"
  >
    <slot />
  </div>
</template>
