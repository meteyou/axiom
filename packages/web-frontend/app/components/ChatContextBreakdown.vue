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

    <div class="-mx-1.5 flex flex-col gap-0.5 text-xs">
      <div v-for="part in parts" :key="part.key">
        <component
          :is="part.children.length > 0 ? 'button' : 'div'"
          :type="part.children.length > 0 ? 'button' : undefined"
          :aria-expanded="part.children.length > 0 ? expanded.has(part.key) : undefined"
          class="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left"
          :class="part.children.length > 0 && 'transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'"
          @click="toggle(part)"
        >
          <AppIcon
            name="chevronRight"
            class="h-3 w-3 shrink-0 text-muted-foreground transition-transform duration-150"
            :class="[expanded.has(part.key) && 'rotate-90', part.children.length === 0 && 'invisible']"
          />
          <span class="h-2 w-2 shrink-0 rounded-full" :class="part.color" aria-hidden="true" />
          <span class="min-w-0 flex-1 truncate font-medium text-foreground">{{ part.label }}</span>
          <span class="tabular-nums text-foreground">~{{ formatTokenCount(part.tokens) }}</span>
          <span class="w-9 text-right tabular-nums text-muted-foreground">{{ share(part.tokens, total) }}%</span>
        </component>
        <ul
          v-if="part.children.length > 0 && expanded.has(part.key)"
          class="mb-1.5 ml-[11px] mt-0.5 flex flex-col gap-1 border-l border-border py-0.5 pl-[25px] pr-1.5"
        >
          <li v-for="child in part.children" :key="child.key" class="flex items-center gap-2 text-muted-foreground">
            <span class="min-w-0 flex-1 truncate" :title="child.label">{{ child.label }}</span>
            <span class="tabular-nums">~{{ formatTokenCount(child.tokens) }}</span>
            <span class="w-9 text-right tabular-nums">{{ share(child.tokens, part.tokens) }}%</span>
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { contextUsagePercent, formatTokenCount, type ContextUsageBreakdown } from '@axiom/core/contracts'

const props = defineProps<{
  breakdown: ContextUsageBreakdown
}>()

const { t, te } = useI18n()

const CHAT_PARTS = ['summary', 'user', 'assistant', 'toolResults'] as const

const expanded = ref(new Set<string>())

function toggle(part: { key: string; children: unknown[] }) {
  if (part.children.length === 0) return
  const next = new Set(expanded.value)
  if (!next.delete(part.key)) next.add(part.key)
  expanded.value = next
}

const total = computed(() => props.breakdown.systemPrompt.tokens + props.breakdown.toolDefinitions.tokens + props.breakdown.chat.tokens)

const share = contextUsagePercent

function sectionLabel(key: string): string {
  const path = `chat.context.breakdown.sections.${key}`
  return te(path) ? t(path) : key
}

const parts = computed(() => {
  const { systemPrompt, toolDefinitions, chat } = props.breakdown
  return [
    {
      key: 'system',
      label: t('chat.context.breakdown.systemPrompt'),
      tokens: systemPrompt.tokens,
      color: 'bg-primary',
      children: systemPrompt.sections.map(section => ({ key: section.key, label: sectionLabel(section.key), tokens: section.tokens })),
    },
    {
      key: 'tools',
      label: t('chat.context.breakdown.toolDefinitions', { count: toolDefinitions.count }),
      tokens: toolDefinitions.tokens,
      color: 'bg-sky-500',
      children: toolDefinitions.groups.map(group => ({ key: group.name, label: group.name, tokens: group.tokens })),
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
