<script setup lang="ts">
import { cn } from '~/lib/utils'

interface Props {
  modelValue?: string
  defaultValue?: string
  class?: string
}

const props = withDefaults(defineProps<Props>(), {})
const emit = defineEmits<{ (e: 'update:modelValue', value: string): void }>()

const activeTab = ref(props.modelValue ?? props.defaultValue ?? '')

watch(
  () => props.modelValue,
  (v) => {
    if (v !== undefined) activeTab.value = v
  }
)

function setTab(value: string) {
  activeTab.value = value
  emit('update:modelValue', value)
}

provide('tabs-active', activeTab)
provide('tabs-set', setTab)
</script>

<template>
  <div :class="cn('', props.class)" v-bind="$attrs">
    <slot />
  </div>
</template>
