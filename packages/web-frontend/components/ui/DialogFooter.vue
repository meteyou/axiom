<script setup lang="ts">
import { cn } from '~/lib/utils'

interface Props {
  class?: string
}

const props = defineProps<Props>()
</script>

<template>
  <div
    :class="cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end mt-6', props.class)"
    v-bind="$attrs"
  >
    <slot />
  </div>
</template>
