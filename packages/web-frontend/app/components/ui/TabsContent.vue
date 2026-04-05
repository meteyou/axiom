<script setup lang="ts">
import { cn } from '~/lib/utils'

interface Props {
  value: string
  class?: string
}

const props = defineProps<Props>()

const activeTab = inject<Ref<string>>('tabs-active', ref(''))

const isActive = computed(() => activeTab.value === props.value)
</script>

<template>
  <div
    v-if="isActive"
    role="tabpanel"
    :data-state="isActive ? 'active' : 'inactive'"
    :class="cn(
      'mt-4 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
      props.class
    )"
    v-bind="$attrs"
  >
    <slot />
  </div>
</template>
