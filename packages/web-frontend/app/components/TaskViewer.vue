<template>
  <TaskEventsViewer :task-id="taskId" @back="$emit('back')" />
</template>

<script setup lang="ts">
import TaskEventsViewer from '~/features/tasks/components/TaskEventsViewer.vue'

defineProps<{
  taskId: string
}>()

defineEmits<{
  back: []
}>()
</script>
