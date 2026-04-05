<script setup lang="ts">
import { cn } from '~/lib/utils'

interface Props {
  value: string
  class?: string
  disabled?: boolean
}

const props = defineProps<Props>()

const activeTab = inject<Ref<string>>('tabs-active', ref(''))
const setTab = inject<(value: string) => void>('tabs-set', () => {})

const isActive = computed(() => activeTab.value === props.value)
</script>

<template>
  <button
    role="tab"
    type="button"
    :disabled="disabled"
    :aria-selected="isActive"
    :data-state="isActive ? 'active' : 'inactive'"
    :class="cn(
      'inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium ring-offset-background transition-all',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
      'disabled:pointer-events-none disabled:opacity-50',
      'data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm',
      props.class
    )"
    v-bind="$attrs"
    @click="setTab(value)"
  >
    <slot />
  </button>
</template>
