<script setup lang="ts">
import { computed } from 'vue'
import { SelectRoot, type SelectRootEmits, type SelectRootProps, type AcceptableValue } from 'reka-ui'
import { EMPTY_SENTINEL } from '~/lib/selectUtils'

const props = defineProps<SelectRootProps>()
const emits = defineEmits<SelectRootEmits>()

// Strip undefined props (mimics useForwardProps) so reka-ui
// doesn’t treat them as controlled, and map "" ↔ sentinel.
const mappedProps = computed(() => {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined) continue
    if (key === 'modelValue' || key === 'defaultValue') {
      result[key] = value === '' ? EMPTY_SENTINEL : value
    } else {
      result[key] = value
    }
  }
  return result
})

function onModelValueUpdate(value: AcceptableValue) {
  emits('update:modelValue', value === EMPTY_SENTINEL ? '' : value)
}

function onOpenUpdate(value: boolean) {
  emits('update:open', value)
}
</script>

<template>
  <SelectRoot
    v-bind="mappedProps"
    @update:model-value="onModelValueUpdate"
    @update:open="onOpenUpdate"
  >
    <slot />
  </SelectRoot>
</template>
