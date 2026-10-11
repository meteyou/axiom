<template>
  <Popover>
    <PopoverTrigger as-child>
      <button
        type="button"
        class="flex items-center gap-2 rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        :aria-label="$t('chat.context.label', { percent })"
      >
        <svg viewBox="0 0 16 16" class="h-4 w-4 -rotate-90" aria-hidden="true">
          <circle cx="8" cy="8" r="6.5" fill="none" stroke-width="2" class="stroke-border" />
          <circle
            cx="8"
            cy="8"
            r="6.5"
            fill="none"
            stroke-width="2"
            stroke-linecap="round"
            :class="toneStroke"
            :stroke-dasharray="RING_LENGTH"
            :stroke-dashoffset="RING_LENGTH * (1 - percent / 100)"
          />
        </svg>
        <span v-if="!compact" class="tabular-nums">
          {{ tokensLabel }} / {{ formatTokenCount(usage.contextWindow) }}
        </span>
      </button>
    </PopoverTrigger>
    <PopoverContent align="start" class="w-72">
      <div class="flex flex-col gap-3">
        <div class="flex items-baseline justify-between gap-2">
          <p class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{{ $t('chat.context.title') }}</p>
          <span class="text-xs tabular-nums text-muted-foreground">{{ percent }}%</span>
        </div>

        <div>
          <p class="text-lg font-semibold tracking-tight tabular-nums text-foreground">
            {{ tokensLabel }}
            <span class="text-sm font-normal text-muted-foreground">/ {{ formatTokenCount(usage.contextWindow) }} {{ $t('chat.context.tokens') }}</span>
          </p>
          <div class="relative mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div class="h-full rounded-full transition-[width] duration-300" :class="toneFill" :style="{ width: `${percent}%` }" />
            <div
              v-if="usage.autoCompaction"
              class="absolute inset-y-0 w-0.5 bg-foreground/60"
              :style="{ left: `${thresholdPercent}%` }"
              :title="$t('chat.context.threshold')"
            />
          </div>
        </div>

        <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
          <dt class="text-muted-foreground">{{ $t('chat.context.model') }}</dt>
          <dd class="truncate text-right text-foreground" :title="usage.modelId">{{ usage.modelName }}</dd>
          <dt class="text-muted-foreground">{{ $t('chat.context.threshold') }}</dt>
          <dd class="text-right tabular-nums text-foreground">{{ thresholdLabel }}</dd>
        </dl>

        <p v-if="usage.autoCompactionPaused" class="text-xs text-destructive">{{ $t('chat.context.paused') }}</p>
        <p v-if="usage.estimated" class="text-xs text-muted-foreground">{{ $t('chat.context.estimated') }}</p>
      </div>
    </PopoverContent>
  </Popover>
</template>

<script setup lang="ts">
import { contextUsagePercent, formatTokenCount, type ContextUsageInfo } from '@axiom/core/contracts'

const props = defineProps<{
  usage: ContextUsageInfo
  /** Ring only, for narrow toolbars. */
  compact?: boolean
}>()

const { t } = useI18n()

const RING_LENGTH = 2 * Math.PI * 6.5
/** Share of the compaction threshold from which the meter turns amber. */
const WARN_SHARE = 0.8

const percent = computed(() => contextUsagePercent(props.usage.tokens, props.usage.contextWindow))
const thresholdPercent = computed(() => contextUsagePercent(props.usage.compactionThreshold, props.usage.contextWindow))
const tokensLabel = computed(() => `${props.usage.estimated ? '~' : ''}${formatTokenCount(props.usage.tokens)}`)

const tone = computed<'normal' | 'warn' | 'critical'>(() => {
  const { tokens, compactionThreshold, autoCompaction, autoCompactionPaused } = props.usage
  if (autoCompactionPaused) return 'critical'
  if (!autoCompaction) return tokens >= WARN_SHARE * props.usage.contextWindow ? 'warn' : 'normal'
  return tokens >= WARN_SHARE * compactionThreshold ? 'warn' : 'normal'
})
const toneStroke = computed(() => ({ normal: 'stroke-primary', warn: 'stroke-warning', critical: 'stroke-destructive' })[tone.value])
const toneFill = computed(() => ({ normal: 'bg-primary', warn: 'bg-warning', critical: 'bg-destructive' })[tone.value])

const thresholdLabel = computed(() => props.usage.autoCompaction
  ? t('chat.context.thresholdValue', { tokens: formatTokenCount(props.usage.compactionThreshold), percent: thresholdPercent.value })
  : t('chat.context.autoOff'))
</script>
