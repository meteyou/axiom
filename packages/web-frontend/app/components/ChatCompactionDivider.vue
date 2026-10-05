<template>
  <div class="w-full max-w-none px-2">
    <div class="relative flex items-center py-2">
      <div class="grow border-t border-border" />
      <button
        type="button"
        class="mx-4 flex shrink-0 items-center gap-2 text-xs"
        :class="[
          info.status === 'failed' ? 'text-destructive' : 'text-muted-foreground',
          canExpand ? 'cursor-pointer hover:text-foreground' : 'cursor-default',
        ]"
        :disabled="!canExpand"
        :aria-expanded="canExpand ? expanded : undefined"
        @click="expanded = !expanded"
      >
        <AppIcon :name="info.status === 'failed' ? 'warning' : 'compress'" class="h-3 w-3" />
        <span>{{ label }}</span>
        <span v-if="info.status === 'running'" class="inline-flex items-center gap-1">
          <span class="h-1 w-1 animate-pulse rounded-full bg-current opacity-60" />
          <span class="h-1 w-1 animate-pulse rounded-full bg-current opacity-60" />
          <span class="h-1 w-1 animate-pulse rounded-full bg-current opacity-60" />
        </span>
        <AppIcon v-if="canExpand" :name="expanded ? 'chevronDown' : 'chevronRight'" class="h-3 w-3" />
      </button>
      <div class="grow border-t border-border" />
    </div>
    <div
      v-if="canExpand && expanded"
      class="mx-auto mb-2 max-w-lg rounded-lg border border-border/60 bg-muted/10 px-4 py-3"
    >
      <div class="prose-chat break-words text-xs text-foreground" v-html="renderMarkdown(info.summary ?? '')" />
    </div>
  </div>
</template>

<script setup lang="ts">
import type { ChatCompactionInfo } from '~/composables/useChat'

const props = defineProps<{
  info: ChatCompactionInfo
}>()

const { t } = useI18n()
const { renderMarkdown } = useMarkdown()
const expanded = ref(false)

const canExpand = computed(() => props.info.status === 'completed' && Boolean(props.info.summary))

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`
  return String(Math.max(0, Math.round(tokens)))
}

const label = computed(() => {
  const before = formatTokens(props.info.tokensBefore)
  switch (props.info.status) {
    case 'running':
      return t('chat.compaction.running', { before })
    case 'completed':
      return t('chat.compaction.completed', { before, after: formatTokens(props.info.tokensAfter ?? 0) })
    case 'skipped':
      return t('chat.compaction.skipped')
    case 'failed':
      return t('chat.compaction.failed', { error: props.info.error ?? '' })
  }
  return ''
})
</script>
