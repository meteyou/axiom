<script setup lang="ts">
interface Props {
  open?: boolean
}

const props = defineProps<Props>()
const emit = defineEmits<{ (e: 'update:open', value: boolean): void }>()

const isOpen = computed(() => props.open ?? false)

provide('dialog-open', isOpen)
provide('dialog-close', () => emit('update:open', false))
</script>

<template>
  <slot />
</template>
