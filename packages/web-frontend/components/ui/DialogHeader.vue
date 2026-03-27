<script setup lang="ts">
import { cn } from '~/lib/utils'

interface Props {
  class?: string
}

const props = defineProps<Props>()
</script>

<template>
  <div
    :class="cn('flex flex-col gap-1.5 text-left mb-4', props.class)"
    v-bind="$attrs"
  >
    <slot />
  </div>
</template>
