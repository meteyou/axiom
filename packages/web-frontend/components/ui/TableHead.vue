<script setup lang="ts">
import { cn } from '~/lib/utils'

interface Props {
  class?: string
}

const props = defineProps<Props>()
</script>

<template>
  <th
    :class="cn(
      'h-12 px-4 text-left align-middle text-xs font-semibold uppercase tracking-wide text-muted-foreground [&:has([role=checkbox])]:pr-0',
      props.class
    )"
    v-bind="$attrs"
  >
    <slot />
  </th>
</template>
