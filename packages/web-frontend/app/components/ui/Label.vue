<script setup lang="ts">
import { cn } from '~/lib/utils'

interface Props {
  class?: string
  for?: string
  required?: boolean
}

const props = defineProps<Props>()
</script>

<template>
  <label
    :for="props.for"
    :class="cn(
      'text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70',
      props.class
    )"
    v-bind="$attrs"
  >
    <slot />
    <span v-if="required" class="ml-0.5 text-destructive" aria-hidden="true">*</span>
  </label>
</template>
