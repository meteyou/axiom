<template>
  <div class="space-y-3 text-xs">
    <div v-if="code">
      <p class="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{{ t('codemode.script') }}</p>
      <!-- eslint-disable-next-line vue/no-v-html -->
      <div v-if="scriptHtml" class="max-h-80 overflow-auto rounded-md [&_pre]:min-w-full [&_pre]:w-max [&_pre]:px-2.5 [&_pre]:py-2 [&_pre]:leading-5" v-html="scriptHtml" />
      <pre v-else class="max-h-80 overflow-x-auto whitespace-pre rounded-md border border-border/60 bg-muted/20 px-2.5 py-2 leading-5">{{ code }}</pre>
    </div>

    <div>
      <p class="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {{ t('codemode.toolCalls') }}
        <span v-if="rows.length > 0" class="text-muted-foreground/60">({{ rows.length }})</span>
      </p>
      <p v-if="rows.length === 0" class="text-muted-foreground/70">{{ t('codemode.noToolCalls') }}</p>
      <div v-else>
        <div v-for="row in rows" :key="row.id">
          <div class="flex items-center gap-2 py-1">
            <AppIcon
              :name="row.status === 'running' ? 'loader' : row.status === 'ok' ? 'success' : row.status === 'cancelled' ? 'close' : 'warning'"
              class="h-3 w-3 shrink-0"
              :class="{
                'animate-spin opacity-80': row.status === 'running',
                'text-emerald-500': row.status === 'ok',
                'text-destructive': row.status === 'error',
                'opacity-50': row.status === 'cancelled',
              }"
            />
            <span class="shrink-0 font-medium" :class="row.status === 'error' ? 'text-destructive' : ''">{{ row.displayName }}</span>
            <span
              v-if="row.summary"
              class="min-w-0 truncate font-mono text-muted-foreground/70"
              :title="row.summary"
            >{{ row.summary }}</span>
            <span class="flex-1" />
            <span
              v-if="row.status === 'cancelled'"
              class="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
            >{{ t('codemode.cancelled') }}</span>
            <span v-if="row.durationMs !== undefined" class="shrink-0 text-[10px] tabular-nums text-muted-foreground/70">
              {{ formatDuration(row.durationMs) }}
            </span>
          </div>
          <p
            v-if="row.errorPreview"
            class="ml-5 truncate text-[11px] text-destructive"
            :title="row.errorPreview"
          >{{ row.errorPreview }}</p>
        </div>
      </div>
    </div>

    <div v-if="output">
      <p class="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{{ t('codemode.output') }}</p>
      <pre
        class="max-h-80 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border/60 bg-muted/20 px-2.5 py-2 leading-5"
        :class="isError ? 'text-destructive' : 'text-foreground'"
      >{{ output }}</pre>
    </div>
  </div>
</template>

<script setup lang="ts">
import { toCodemodeCallRows, type CodemodeNestedCall } from '~/utils/codemodeDisplay'
import { highlightJavaScript } from '~/utils/codeHighlight'

const props = withDefaults(defineProps<{
  code: string
  nestedCalls: CodemodeNestedCall[]
  output: string | null
  isError?: boolean
}>(), {
  isError: false,
})

const { t } = useI18n()
const { isDark } = useTheme()

const rows = computed(() => toCodemodeCallRows(props.nestedCalls))

const scriptHtml = ref('')
let highlightSeq = 0
watch([() => props.code, isDark], async () => {
  const seq = ++highlightSeq
  if (!props.code) {
    scriptHtml.value = ''
    return
  }
  try {
    const html = await highlightJavaScript(props.code, isDark.value)
    if (seq === highlightSeq) scriptHtml.value = html
  } catch {
    // Fall back to the plain <pre> if the highlighter fails to load.
  }
}, { immediate: true })

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}
</script>
