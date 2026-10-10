<template>
  <Dialog :open="open" @update:open="(v: boolean) => { if (!v) emit('close') }">
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{{ mode === 'create' ? $t('users.addUser') : $t('users.editUser') }}</DialogTitle>
        <DialogDescription>{{ mode === 'create' ? $t('users.addUserDescription') : $t('users.editUserDescription') }}</DialogDescription>
      </DialogHeader>

      <form class="flex flex-col gap-4" @submit.prevent="handleSubmit">
        <!-- Username (create only) -->
        <div v-if="mode === 'create'" class="flex flex-col gap-1.5">
          <Label for="modal-username">{{ $t('users.username') }}</Label>
          <Input
            id="modal-username"
            v-model="form.username"
            type="text"
            autocomplete="username"
            required
          />
        </div>

        <!-- Role -->
        <div class="flex flex-col gap-1.5">
          <Label for="modal-role">{{ $t('users.role') }}</Label>
          <Select v-model="form.role">
            <SelectTrigger id="modal-role">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="user">{{ $t('roles.user') }}</SelectItem>
              <SelectItem value="admin">{{ $t('roles.admin') }}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <template v-if="mode === 'create' && form.role === 'user'">
          <div class="flex flex-col gap-1.5">
            <Label for="modal-language">{{ $t('settings.language') }}</Label>
            <Select v-model="form.language">
              <SelectTrigger id="modal-language">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem :value="DEFAULT_VALUE">{{ $t('users.useDefault') }}</SelectItem>
                <SelectItem v-for="lang in LANGUAGE_OPTIONS" :key="lang.value" :value="lang.value">{{ $t(`settings.${lang.key}`) }}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div class="flex flex-col gap-1.5">
            <Label for="modal-timezone">{{ $t('settings.timezone') }}</Label>
            <Select v-model="form.timezone">
              <SelectTrigger id="modal-timezone">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem :value="DEFAULT_VALUE">{{ $t('users.useDefault') }}</SelectItem>
                <SelectItem v-for="tz in TIMEZONE_OPTIONS" :key="tz" :value="tz">{{ tz }}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </template>

        <!-- Password -->
        <div class="flex flex-col gap-1.5">
          <Label for="modal-password">
            {{ mode === 'create' ? $t('users.password') : $t('users.resetPassword') }}
          </Label>
          <Input
            id="modal-password"
            v-model="form.password"
            type="password"
            autocomplete="new-password"
            :required="mode === 'create'"
            :placeholder="mode === 'create' ? $t('users.passwordPlaceholder') : $t('users.passwordOptional')"
          />
          <p class="text-xs text-muted-foreground">
            {{ mode === 'create' ? $t('users.passwordHint') : $t('users.passwordResetHint') }}
          </p>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" @click="emit('close')">
            {{ $t('common.cancel') }}
          </Button>
          <Button type="submit" :disabled="loading">
            <span
              v-if="loading"
              class="mr-1 h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground/30 border-t-primary-foreground"
              aria-hidden="true"
            />
            {{ $t('common.save') }}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import type { User } from '~/composables/useUsers'
import { LANGUAGE_OPTIONS, TIMEZONE_OPTIONS } from '~/utils/settingsOptions'

const DEFAULT_VALUE = '__default__'

const props = defineProps<{
  open: boolean
  mode: 'create' | 'edit'
  user?: User | null
  loading?: boolean
}>()

const emit = defineEmits<{
  close: []
  submit: [payload: { username: string; password: string; role: string; language: string; timezone: string }]
}>()

const form = reactive({
  username: '',
  password: '',
  role: 'user',
  language: DEFAULT_VALUE,
  timezone: DEFAULT_VALUE,
})

// Sync form state when dialog opens or user changes
watch(() => [props.open, props.user] as const, ([isOpen, entry]) => {
  if (isOpen && props.mode === 'edit' && entry) {
    form.username = entry.username
    form.password = ''
    form.role = entry.role
  } else if (isOpen && props.mode === 'create') {
    form.username = ''
    form.password = ''
    form.role = 'user'
    form.language = DEFAULT_VALUE
    form.timezone = DEFAULT_VALUE
  }
}, { immediate: true })

function handleSubmit() {
  emit('submit', {
    ...form,
    language: form.language === DEFAULT_VALUE ? '' : form.language,
    timezone: form.timezone === DEFAULT_VALUE ? '' : form.timezone,
  })
}
</script>
