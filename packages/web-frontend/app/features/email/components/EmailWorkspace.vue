<template>
  <div class="flex h-full flex-col overflow-hidden">
    <PageHeader :title="$t('email.title')" :subtitle="$t('email.subtitle')" />

    <div class="mx-auto flex w-full max-w-6xl flex-1 flex-col overflow-hidden p-6">
      <Tabs v-model="activeTab" class="flex min-h-0 flex-1 flex-col overflow-hidden">
        <TabsList v-if="isAdmin" class="mb-4 shrink-0 self-start">
          <TabsTrigger value="accounts">{{ $t('email.accountsTab') }}</TabsTrigger>
          <TabsTrigger value="sentLog">{{ $t('email.sentLogTab') }}</TabsTrigger>
        </TabsList>

        <TabsContent v-if="isAdmin" value="accounts" class="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden">
          <EmailAccountsWorkspace />
        </TabsContent>

        <TabsContent value="sentLog" class="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden">
          <EmailSendLogWorkspace />
        </TabsContent>
      </Tabs>
    </div>
  </div>
</template>

<script setup lang="ts">
import EmailAccountsWorkspace from './EmailAccountsWorkspace.vue'
import EmailSendLogWorkspace from './EmailSendLogWorkspace.vue'

const { user } = useAuth()
const isAdmin = computed(() => user.value?.role === 'admin')

const activeTab = ref(isAdmin.value ? 'accounts' : 'sentLog')
</script>
