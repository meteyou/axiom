<template>
  <div
    v-if="!isAdmin"
    class="flex h-full flex-col items-center justify-center gap-3 p-10 text-center text-muted-foreground"
  >
    <AppIcon name="lock" size="xl" class="opacity-50" />
    <h1 class="text-lg font-semibold text-foreground">{{ $t('admin.title') }}</h1>
    <p class="max-w-xs text-sm">{{ $t('admin.description') }}</p>
  </div>

  <TaskEventsViewer
    v-else
    :task-id="taskId"
    @back="navigateTo('/tasks')"
    @restarted="onTaskRestarted"
  />
</template>

<script setup lang="ts">
import TaskEventsViewer from '~/features/tasks/components/TaskEventsViewer.vue'

const route = useRoute()
const { user } = useAuth()
const isAdmin = computed(() => user.value?.role === 'admin')

const taskId = computed(() => String(route.params.id))

function onTaskRestarted(newTaskId: string) {
  navigateTo(`/tasks/${newTaskId}`)
}
</script>
