<template>
  <div class="flex flex-col gap-2.5 border-t border-border pt-3">
    <p class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{{ $t('chat.context.breakdown.title') }}</p>

    <div class="flex h-1.5 w-full gap-px overflow-hidden rounded-full bg-muted">
      <div
        v-for="part in parts.filter(p => p.tokens > 0)"
        :key="part.key"
        class="h-full"
        :class="part.color"
        :style="{ width: `${(part.tokens / total) * 100}%` }"
        :title="part.label"
      />
    </div>

    <div class="flex flex-col gap-2 text-xs">
      <div v-for="part in parts" :key="part.key" class="flex flex-col gap-1">
        <div class="flex items-center gap-2">
          <span class="h-2 w-2 shrink-0 rounded-full" :class="part.color" aria-hidden="true" />
          <span class="min-w-0 flex-1 truncate text-foreground">{{ part.label }}</span>
          <span class="tabular-nums text-foreground">~{{ formatTokenCount(part.tokens) }}</span>
          <span class="w-9 text-right tabular-nums text-muted-foreground">{{ share(part.tokens, total) }}%</span>
        </div>
        <ul v-if="part.children.length > 0" class="flex flex-col gap-0.5 pl-4">
          <li v-for="child in part.children" :key="child.key" class="flex items-center gap-2 text-muted-foreground">
            <span class="min-w-0 flex-1 truncate" :title="child.label">{{ child.label }}</span>
            <span class="tabular-nums">~{{ formatTokenCount(child.tokens) }}</span>
            <span class="w-9 text-right tabular-nums">{{ share(child.tokens, part.tokens) }}%</span>
          </li>
          <li v-if="part.key === 'system' && hiddenSections > 0">
            <button
              type="button"
              class="flex items-center gap-1 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              @click="showAllSections = !showAllSections"
            >
              <AppIcon :name="showAllSections ? 'chevronDown' : 'chevronRight'" class="h-3 w-3" />
              {{ showAllSections ? $t('chat.context.breakdown.showLess') : $t('chat.context.breakdown.showMore', { count: hiddenSections }) }}
            </button>
          </li>
        </ul>
      </div>
    </div>

    <p class="text-xs text-muted-foreground">{{ $t('chat.context.breakdown.estimated') }}</p>
  </div>
</template>

<script setup lang="ts">
import { contextUsagePercent, formatTokenCount, type ContextUsageBreakdown } from '@axiom/core/contracts'

const props = defineProps<{
  breakdown: ContextUsageBreakdown
}>()

const { t, te } = useI18n()

const COLLAPSED_SECTIONS = 5
const CHAT_PARTS = ['summary', 'user', 'assistant', 'toolResults'] as const

const showAllSections = ref(false)

const total = computed(() => props.breakdown.systemPrompt.tokens + props.breakdown.toolDefinitions.tokens + props.breakdown.chat.tokens)

const share = contextUsagePercent

function sectionLabel(key: string): string {
  const path = `chat.context.breakdown.sections.${key}`
  return te(path) ? t(path) : key
}

const hiddenSections = computed(() => Math.max(0, props.breakdown.systemPrompt.sections.length - COLLAPSED_SECTIONS))

const parts = computed(() => {
  const { systemPrompt, toolDefinitions, chat } = props.breakdown
  const sections = showAllSections.value ? systemPrompt.sections : systemPrompt.sections.slice(0, COLLAPSED_SECTIONS)
  return [
    {
      key: 'system',
      label: t('chat.context.breakdown.systemPrompt'),
      tokens: systemPrompt.tokens,
      color: 'bg-primary',
      children: sections.map(section => ({ key: section.key, label: sectionLabel(section.key), tokens: section.tokens })),
    },
    {
      key: 'tools',
      label: t('chat.context.breakdown.toolDefinitions', { count: toolDefinitions.count }),
      tokens: toolDefinitions.tokens,
      color: 'bg-sky-500',
      children: [],
    },
    {
      key: 'chat',
      label: t('chat.context.breakdown.chat'),
      tokens: chat.tokens,
      color: 'bg-violet-500',
      children: CHAT_PARTS
        .filter(part => chat[part] > 0)
        .map(part => ({ key: part, label: t(`chat.context.breakdown.chatParts.${part}`), tokens: chat[part] })),
    },
  ]
})
</script>
