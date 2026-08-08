<template>
  <div
    v-if="!isAdmin"
    class="flex h-full flex-col items-center justify-center gap-3 p-10 text-center text-muted-foreground"
  >
    <AppIcon name="lock" size="xl" class="opacity-50" />
    <h1 class="text-lg font-semibold text-foreground">{{ $t('admin.title') }}</h1>
    <p class="max-w-xs text-sm">{{ $t('admin.description') }}</p>
  </div>

  <EmailAccountsWorkspace v-else />
</template>

<script setup lang="ts">
import EmailAccountsWorkspace from '~/features/email/components/EmailAccountsWorkspace.vue'

const { user } = useAuth()
const isAdmin = computed(() => user.value?.role === 'admin')
</script>
