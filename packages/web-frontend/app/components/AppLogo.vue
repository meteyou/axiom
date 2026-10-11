<template>
  <img
    :src="asset.src"
    alt=""
    aria-hidden="true"
    draggable="false"
    class="shrink-0 select-none"
    :class="{
      'h-8 w-8': size === 'xs',
      'h-[34px] w-[34px]': size === 'sm',
      'h-10 w-10': size === 'md',
      'h-[52px] w-[52px]': size === 'lg',
    }"
  >
</template>

<script setup lang="ts">
withDefaults(defineProps<{
  size?: 'xs' | 'sm' | 'md' | 'lg'
}>(), {
  size: 'md',
})

const { asset } = useAppLogo()
</script>
