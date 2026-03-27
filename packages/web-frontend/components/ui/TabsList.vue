<script setup lang="ts">
import { cn } from '~/lib/utils'

interface Props {
  class?: string
}

const props = defineProps<Props>()
</script>

<template>
  <div
    role="tablist"
    :class="cn(
      'inline-flex items-center rounded-lg bg-muted p-1 text-muted-foreground gap-1',
      props.class
    )"
    v-bind="$attrs"
  >
    <slot />
  </div>
</template>
