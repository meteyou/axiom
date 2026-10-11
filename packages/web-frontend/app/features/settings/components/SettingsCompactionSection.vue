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

    <div class="flex items-center justify-between rounded-lg border border-border px-4 py-3">
      <div class="flex flex-col gap-0.5 pr-4">
        <Label for="compaction-enabled" class="cursor-pointer">
          {{ $t('settings.compaction.enabled') }}
        </Label>
        <p class="text-xs text-muted-foreground">{{ $t('settings.compaction.enabledHint') }}</p>
      </div>
      <Switch id="compaction-enabled" v-model:checked="compaction.enabled" />
    </div>

    <div v-if="compaction.enabled" class="flex items-center justify-between rounded-lg border border-border px-4 py-3">
      <div class="flex flex-col gap-0.5 pr-4">
        <Label for="compaction-tasks-enabled" class="cursor-pointer">
          {{ $t('settings.compaction.tasksEnabled') }}
        </Label>
        <p class="text-xs text-muted-foreground">{{ $t('settings.compaction.tasksEnabledHint') }}</p>
      </div>
      <Switch id="compaction-tasks-enabled" v-model:checked="compaction.tasks.enabled" />
    </div>
  </div>
</template>

<script setup lang="ts">
import type { CompactionSettingsContract } from '@axiom/core/contracts'

const compaction = defineModel<CompactionSettingsContract>({ required: true })
</script>
