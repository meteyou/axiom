<template>
  <div
    class="w-full overflow-hidden rounded-lg border text-xs"
    :class="isError ? 'border-destructive/50' : 'border-border'"
  >
    <button
      type="button"
      class="flex w-full items-center gap-2 border-b border-transparent bg-muted/30 px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/60"
      :class="{ 'border-border': expanded }"
      @click="$emit('toggle')"
    >
      <AppIcon
        :name="running ? 'loader' : 'terminal'"
        class="h-3 w-3 shrink-0"
        :class="running ? 'animate-spin opacity-80' : isError ? 'text-destructive' : 'opacity-60'"
      />
      <span class="shrink-0 font-medium" :class="isError ? 'text-destructive' : ''">{{ t('codemode.title') }}</span>
      <span
        v-if="isError"
        class="shrink-0 rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium text-destructive"
      >{{ t('codemode.error') }}</span>
      <span
        v-if="!expanded && collapsedLabel"
        class="min-w-0 truncate font-mono text-muted-foreground/70"
        :title="collapsedLabel"
      >{{ collapsedLabel }}</span>
      <span class="flex-1" />
      <span
        v-if="running"
        class="shrink-0 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400"
      >{{ t('codemode.running') }}</span>
      <span v-if="meta" class="shrink-0 whitespace-nowrap text-[10px] tabular-nums text-muted-foreground/80">{{ meta }}</span>
      <AppIcon :name="expanded ? 'chevronDown' : 'chevronRight'" class="h-3 w-3 shrink-0" />
    </button>

    <CodemodeToolBody
      v-if="expanded"
      class="bg-background p-3"
      :code="code"
      :nested-calls="nestedCalls"
      :output="output"
      :is-error="isError"
    />
  </div>
</template>

<script setup lang="ts">
import { codemodeCollapsedSummary, type CodemodeNestedCall } from '~/utils/codemodeDisplay'

const props = withDefaults(defineProps<{
  code: string
  nestedCalls: CodemodeNestedCall[]
  output: string | null
  isError?: boolean
  running?: boolean
  expanded: boolean
  /** Right-side header meta (e.g. a timestamp or duration). */
  meta?: string
}>(), {
  isError: false,
  running: false,
  meta: undefined,
})

defineEmits<{
  toggle: []
}>()

const { t } = useI18n()

const collapsed = computed(() => codemodeCollapsedSummary(props.nestedCalls))
const collapsedLabel = computed(() =>
  collapsed.value.count === 0 ? null : t('codemode.callsSummary', { count: collapsed.value.count, names: collapsed.value.toolNames.join(', ') }),
)
</script>
