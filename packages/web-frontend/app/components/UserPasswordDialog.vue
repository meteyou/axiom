<template>
  <Dialog :open="open" @update:open="(v: boolean) => { if (!v) emit('close') }">
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{{ $t('users.changePassword') }}</DialogTitle>
        <DialogDescription>{{ $t('users.changePasswordDescription') }}</DialogDescription>
      </DialogHeader>

      <form class="flex flex-col gap-4" @submit.prevent="emit('submit', { ...form })">
        <div class="flex flex-col gap-1.5">
          <Label for="own-current-password">{{ $t('users.currentPassword') }}</Label>
          <Input
            id="own-current-password"
            v-model="form.currentPassword"
            type="password"
            autocomplete="current-password"
            required
          />
        </div>

        <div class="flex flex-col gap-1.5">
          <Label for="own-new-password">{{ $t('users.newPassword') }}</Label>
          <Input
            id="own-new-password"
            v-model="form.newPassword"
            type="password"
            autocomplete="new-password"
            required
          />
          <p class="text-xs text-muted-foreground">{{ $t('users.passwordHint') }}</p>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" @click="emit('close')">
            {{ $t('common.cancel') }}
          </Button>
          <Button type="submit" :disabled="loading">
            {{ $t('common.save') }}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
const props = defineProps<{
  open: boolean
  loading?: boolean
}>()

const emit = defineEmits<{
  close: []
  submit: [payload: { currentPassword: string; newPassword: string }]
}>()

const form = reactive({ currentPassword: '', newPassword: '' })

watch(() => props.open, (isOpen) => {
  if (isOpen) {
    form.currentPassword = ''
    form.newPassword = ''
  }
})
</script>
