<template>
  <MemoryWorkspace v-if="isAdmin" />
  <UserMemoryWorkspace v-else />
</template>

<script setup lang="ts">
import MemoryWorkspace from '~/features/memory/components/MemoryWorkspace.vue'
import UserMemoryWorkspace from '~/features/memory/components/UserMemoryWorkspace.vue'

const { user } = useAuth()
const isAdmin = computed(() => user.value?.role === 'admin')
</script>
