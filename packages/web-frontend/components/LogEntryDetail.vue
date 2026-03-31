<script setup lang="ts">
import type { LogEntry } from '~/composables/useLogs'
import { parseLogData, hasInputData } from '~/utils/logDataParsing'
import { hasMemoryConsolidationDiff } from '~/utils/memoryConsolidation'

const props = defineProps<{
  entry: LogEntry | null
  loading: boolean
}>()

const { t } = useI18n()
const { formatDuration } = useFormat()
const { isEntrySkillLoad, extractSkillContent } = useLogDisplay()

const showInput = computed(() => {
  if (!props.entry) return false
  return hasInputData(props.entry.input) && !isEntrySkillLoad(props.entry)
})

const showMemoryDiff = computed(() => {
  if (!props.entry) return false
  return hasMemoryConsolidationDiff(props.entry.toolName, props.entry.output)
})

const isSkillLoad = computed(() => {
  if (!props.entry) return false
  return isEntrySkillLoad(props.entry)
})
</script>

<template>
  <div class="border-t border-border bg-background px-5 pb-4 pt-3" @click.stop>
    <div v-if="loading" class="py-3 text-sm text-muted-foreground">
      {{ t('logs.loading') }}
    </div>

    <template v-else-if="entry">
      <!-- Input (hidden if empty or skill load) -->
      <div v-if="showInput" class="mb-3">
        <h4 class="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {{ t('logs.input') }}
        </h4>
        <div class="oa-scrollbar max-h-[200px] overflow-y-auto rounded-md border border-border bg-muted/50 p-3 text-xs leading-snug">
          <ToolDataDisplay :data="parseLogData(entry.input)" />
        </div>
      </div>

      <!-- Output -->
      <div class="mb-3">
        <h4 class="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {{ t('logs.output') }}
        </h4>
        <div
          class="oa-scrollbar overflow-y-auto rounded-md border border-border bg-muted/50 p-3 text-xs leading-snug"
          :class="showMemoryDiff ? 'max-h-[420px]' : 'max-h-[300px]'"
        >
          <template v-if="isSkillLoad">
            <pre class="whitespace-pre-wrap break-all text-foreground">{{ extractSkillContent(entry.output) ?? '' }}</pre>
          </template>
          <template v-else-if="showMemoryDiff">
            <MemoryConsolidationDiff :output="entry.output" />
          </template>
          <template v-else>
            <ToolDataDisplay :data="parseLogData(entry.output)" :is-error="entry.status === 'error'" />
          </template>
        </div>
      </div>

      <!-- Meta row -->
      <div class="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
        <span>{{ t('logs.sessionId') }}: {{ entry.sessionId }}</span>
        <span>{{ t('logs.duration') }}: {{ formatDuration(entry.durationMs) }}</span>
        <span>{{ t('logs.status') }}: {{ entry.status }}</span>
      </div>
    </template>
  </div>
</template>
