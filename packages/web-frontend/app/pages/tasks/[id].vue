<template>
  <TaskEventsViewer
    :task-id="taskId"
    @back="navigateTo('/tasks')"
    @restarted="onTaskRestarted"
  />
</template>

<script setup lang="ts">
import TaskEventsViewer from '~/features/tasks/components/TaskEventsViewer.vue'

const route = useRoute()

const taskId = computed(() => String(route.params.id))

function onTaskRestarted(newTaskId: string) {
  navigateTo(`/tasks/${newTaskId}`)
}
</script>
