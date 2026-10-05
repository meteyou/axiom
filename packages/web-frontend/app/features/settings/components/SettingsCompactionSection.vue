<template>
  <div class="flex flex-col gap-8">
    <div>
      <h3 class="text-base font-semibold tracking-tight text-foreground">
        {{ $t('settings.compaction.section') }}
      </h3>
      <p class="mt-1 text-sm text-muted-foreground">
        {{ $t('settings.compaction.sectionDescription') }}
      </p>
    </div>

    <Alert v-if="warnings.length > 0" variant="destructive">
      <AlertDescription>
        <p class="font-medium">{{ $t('settings.compaction.warningsTitle') }}</p>
        <ul class="mt-1 list-disc pl-4 text-xs">
          <li v-for="warning in warnings" :key="warning">{{ warning }}</li>
        </ul>
      </AlertDescription>
    </Alert>

    <div class="flex items-center justify-between rounded-lg border border-border px-4 py-3">
      <div class="flex flex-col gap-0.5 pr-4">
        <Label for="compaction-enabled" class="cursor-pointer">
          {{ $t('settings.compaction.enabled') }}
        </Label>
        <p class="text-xs text-muted-foreground">{{ $t('settings.compaction.enabledHint') }}</p>
      </div>
      <Switch id="compaction-enabled" v-model:checked="compaction.enabled" />
    </div>

    <template v-if="compaction.enabled">
      <div class="flex flex-col gap-2">
        <Label for="compaction-max-context">{{ $t('settings.compaction.maxContextTokens') }}</Label>
        <div class="flex items-center gap-2">
          <Input
            id="compaction-max-context"
            v-model="maxContextTokens"
            type="number"
            min="8192"
            step="1000"
            :placeholder="$t('settings.compaction.windowOnly')"
            class="w-full"
          />
          <span class="text-sm text-muted-foreground">{{ $t('settings.compaction.tokensUnit') }}</span>
        </div>
        <p class="text-xs text-muted-foreground">{{ $t('settings.compaction.maxContextTokensHint') }}</p>
      </div>

      <div
        v-for="field in tokenFields"
        :key="field.key"
        class="flex flex-col gap-2"
      >
        <Label :for="`compaction-${field.key}`">{{ $t(`settings.compaction.${field.key}`) }}</Label>
        <div class="flex items-center gap-2">
          <Input
            :id="`compaction-${field.key}`"
            v-model.number="compaction[field.key]"
            type="number"
            :min="field.min"
            :step="field.step"
            class="w-full"
          />
          <span class="text-sm text-muted-foreground">{{ $t(field.unitKey) }}</span>
        </div>
        <p class="text-xs text-muted-foreground">{{ $t(`settings.compaction.${field.key}Hint`) }}</p>
      </div>

      <div class="flex items-center justify-between rounded-lg border border-border px-4 py-3">
        <div class="flex flex-col gap-0.5 pr-4">
          <Label for="compaction-tasks-enabled" class="cursor-pointer">
            {{ $t('settings.compaction.tasksEnabled') }}
          </Label>
          <p class="text-xs text-muted-foreground">{{ $t('settings.compaction.tasksEnabledHint') }}</p>
        </div>
        <Switch id="compaction-tasks-enabled" v-model:checked="compaction.tasks.enabled" />
      </div>

      <div v-if="compaction.tasks.enabled" class="flex flex-col gap-2">
        <Label for="compaction-tasks-max-context">{{ $t('settings.compaction.tasksMaxContextTokens') }}</Label>
        <div class="flex items-center gap-2">
          <Input
            id="compaction-tasks-max-context"
            v-model="tasksMaxContextTokens"
            type="number"
            min="8192"
            step="1000"
            :placeholder="$t('settings.compaction.windowOnly')"
            class="w-full"
          />
          <span class="text-sm text-muted-foreground">{{ $t('settings.compaction.tokensUnit') }}</span>
        </div>
        <p class="text-xs text-muted-foreground">{{ $t('settings.compaction.tasksMaxContextTokensHint') }}</p>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import type { CompactionSettingsContract } from '@axiom/core/contracts'

type NumericCompactionField = 'reserveTokens' | 'keepRecentTokens' | 'summaryMaxTokens' | 'toolResultMaxChars'

withDefaults(defineProps<{
  /** Models the backend reported as too small for the saved settings. */
  warnings?: string[]
}>(), {
  warnings: () => [],
})

const compaction = defineModel<CompactionSettingsContract>({ required: true })

const tokenFields: { key: NumericCompactionField; min: number; step: number; unitKey: string }[] = [
  { key: 'reserveTokens', min: 1024, step: 1024, unitKey: 'settings.compaction.tokensUnit' },
  { key: 'keepRecentTokens', min: 1000, step: 1000, unitKey: 'settings.compaction.tokensUnit' },
  { key: 'summaryMaxTokens', min: 256, step: 256, unitKey: 'settings.compaction.tokensUnit' },
  { key: 'toolResultMaxChars', min: 200, step: 100, unitKey: 'settings.compaction.charsUnit' },
]

/** An empty field means "no soft budget": compact against the model's window only. */
function toNullableTokens(value: string | number): number | null {
  if (value === '' || value === null || value === undefined) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

const maxContextTokens = computed({
  get: () => compaction.value.maxContextTokens ?? '',
  set: (value: string | number) => { compaction.value.maxContextTokens = toNullableTokens(value) },
})

const tasksMaxContextTokens = computed({
  get: () => compaction.value.tasks.maxContextTokens ?? '',
  set: (value: string | number) => { compaction.value.tasks.maxContextTokens = toNullableTokens(value) },
})
</script>
