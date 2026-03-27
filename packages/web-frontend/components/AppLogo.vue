<template>
  <span class="app-logo" :class="[`app-logo--${size}`]">
    <AppIcon name="bot" :size="iconSize" />
  </span>
</template>

<script setup lang="ts">
const props = withDefaults(defineProps<{
  size?: 'sm' | 'md' | 'lg'
}>(), {
  size: 'md',
})

const iconSize = computed(() => {
  switch (props.size) {
    case 'sm': return 16
    case 'lg': return 22
    default: return 18
  }
})
</script>

<style scoped>
.app-logo {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 14px;
  background: rgba(90, 102, 255, 0.12);
  color: var(--color-primary);
  border: 1px solid rgba(90, 102, 255, 0.22);
}

.app-logo--sm {
  width: 34px;
  height: 34px;
}

.app-logo--md {
  width: 40px;
  height: 40px;
}

.app-logo--lg {
  width: 52px;
  height: 52px;
  border-radius: 18px;
}
</style>
