<template>
  <span class="shrink-0 text-[10px] tabular-nums text-muted-foreground/80">{{ label }}</span>
</template>

<script setup lang="ts">
import { useNow } from '@vueuse/core'
import { formatDurationSeconds, parseBackendTimestamp } from '~/utils/datetime'

const props = defineProps<{
  since?: string
}>()

const now = useNow({ interval: 1000 })

const label = computed(() => {
  const startedAt = parseBackendTimestamp(props.since)?.getTime() ?? now.value.getTime()
  return formatDurationSeconds((now.value.getTime() - startedAt) / 1000)
})
</script>
