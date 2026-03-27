<script setup lang="ts">
import { cn } from '~/lib/utils'

interface Props {
  class?: string
  modelValue?: string
  disabled?: boolean
  id?: string
  name?: string
  required?: boolean
}

const props = defineProps<Props>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
  (e: 'change', event: Event): void
}>()

function handleChange(event: Event) {
  const target = event.target as HTMLSelectElement
  emit('update:modelValue', target.value)
  emit('change', event)
}
</script>

<template>
  <select
    :id="id"
    :name="name"
    :disabled="disabled"
    :required="required"
    :value="modelValue"
    :class="cn(
      'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
      'disabled:cursor-not-allowed disabled:opacity-50',
      'transition-colors appearance-none',
      props.class
    )"
    v-bind="$attrs"
    @change="handleChange"
  >
    <slot />
  </select>
</template>
