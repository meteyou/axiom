<template>
  <span
    class="inline-flex items-center justify-center bg-primary/[0.12] text-primary border border-primary/[0.22]"
    :class="{
      'w-[34px] h-[34px] rounded-[14px]': size === 'sm',
      'w-10 h-10 rounded-[14px]': size === 'md',
      'w-[52px] h-[52px] rounded-[18px]': size === 'lg',
    }"
  >
    <AppIcon name="bot" :size="iconSize" />
  </span>
</template>

<script setup lang="ts">
const props = withDefaults(defineProps<{
  size?: 'sm' | 'md' | 'lg'
}>(), {
  size: 'md',
})

const iconSize = computed(() => {
  switch (props.size) {
    case 'sm': return 16
    case 'lg': return 28
    default: return 18
  }
})
</script>
