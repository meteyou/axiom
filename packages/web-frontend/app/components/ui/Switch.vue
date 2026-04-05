<script setup lang="ts">
import { type HTMLAttributes, computed } from 'vue'
import { SwitchRoot, SwitchThumb, type SwitchRootEmits, type SwitchRootProps, useForwardPropsEmits } from 'reka-ui'
import { cn } from '~/lib/utils'

interface Props extends SwitchRootProps {
  class?: HTMLAttributes['class']
}

const props = defineProps<Props>()
const emits = defineEmits<SwitchRootEmits>()

const delegatedProps = computed(() => {
  const { class: _, ...delegated } = props
  return delegated
})

const forwarded = useForwardPropsEmits(delegatedProps, emits)
</script>

<template>
  <SwitchRoot
    v-bind="forwarded"
    :class="cn(
      'peer relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
      'disabled:cursor-not-allowed disabled:opacity-50',
      'data-[state=checked]:bg-primary data-[state=unchecked]:bg-input',
      props.class
    )"
  >
    <SwitchThumb
      :class="cn(
        'pointer-events-none block h-5 w-5 rounded-full bg-background shadow-lg ring-0 transition-transform',
        'data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0'
      )"
    />
  </SwitchRoot>
</template>
