<script setup lang="ts">
const { t } = useI18n()

const searchQuery = defineModel<string>('search', { required: true })
const selectedSourceFilter = defineModel<'' | 'main' | 'task'>('sourceFilter', { required: true })
const selectedToolName = defineModel<string>('toolName', { required: true })
const dateFrom = defineModel<string>('dateFrom', { required: true })
const dateTo = defineModel<string>('dateTo', { required: true })

defineProps<{
  toolNames: string[]
}>()

const emit = defineEmits<{
  (e: 'search'): void
  (e: 'apply'): void
}>()
</script>

<template>
  <div class="flex-shrink-0 border-b border-border px-5 py-4">
    <div class="flex flex-wrap gap-2">
      <Input
        v-model="searchQuery"
        type="text"
        :placeholder="t('logs.searchPlaceholder')"
        class="min-w-[180px] flex-1 sm:flex-none"
        @input="emit('search')"
      />

      <Select v-model="selectedSourceFilter" class="w-[150px]" @change="emit('apply')">
        <option value="">{{ t('logs.allSources') }}</option>
        <option value="main">{{ t('logs.sourceMainAgent') }}</option>
        <option value="task">{{ t('logs.sourceTasks') }}</option>
      </Select>

      <Select v-model="selectedToolName" class="w-[150px]" @change="emit('apply')">
        <option value="">{{ t('logs.allTools') }}</option>
        <option v-for="name in toolNames" :key="name" :value="name">{{ name }}</option>
      </Select>

      <DateRangePicker
        v-model:date-from="dateFrom"
        v-model:date-to="dateTo"
        @change="emit('apply')"
      />
    </div>
  </div>
</template>
