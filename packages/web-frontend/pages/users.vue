<template>
  <!-- Admin gate -->
  <div v-if="!isAdmin" class="flex h-full flex-col items-center justify-center gap-3 p-10 text-center text-muted-foreground">
    <AppIcon name="lock" size="xl" class="h-10 w-10" />
    <h1 class="text-xl font-semibold text-foreground">{{ $t('admin.title') }}</h1>
    <p class="text-sm">{{ $t('admin.description') }}</p>
  </div>

  <!-- Page body -->
  <div v-else class="mx-auto flex h-full max-w-5xl flex-col overflow-y-auto p-6">
    <!-- Page header -->
    <div class="mb-6 flex items-end justify-between gap-4">
      <div>
        <p class="mb-1.5 text-xs font-semibold uppercase tracking-widest text-primary">{{ $t('users.kicker') }}</p>
        <h1 class="text-2xl font-bold text-foreground">{{ $t('users.title') }}</h1>
        <p class="mt-1.5 text-sm text-muted-foreground">{{ $t('users.subtitle') }}</p>
      </div>
      <Button @click="openCreateModal">
        <AppIcon name="add" class="mr-1 h-4 w-4" />
        {{ $t('users.addUser') }}
      </Button>
    </div>

    <!-- Error / success banners -->
    <Alert v-if="errorMessage" variant="destructive" class="mb-4">
      <AlertDescription class="flex items-center justify-between">
        <span>{{ errorMessage }}</span>
        <button type="button" class="ml-2 opacity-70 hover:opacity-100 transition-opacity" @click="clearMessages">
          <AppIcon name="close" class="h-4 w-4" />
        </button>
      </AlertDescription>
    </Alert>

    <Alert v-if="successMessage" variant="success" class="mb-4">
      <AlertDescription class="flex items-center justify-between">
        <span>{{ successMessage }}</span>
        <button type="button" class="ml-2 opacity-70 hover:opacity-100 transition-opacity" @click="clearMessages">
          <AppIcon name="close" class="h-4 w-4" />
        </button>
      </AlertDescription>
    </Alert>

    <!-- Loading state -->
    <div v-if="loading && users.length === 0" class="flex flex-1 items-center justify-center py-20 text-sm text-muted-foreground">
      {{ $t('users.loading') }}
    </div>

    <!-- Empty state -->
    <div v-else-if="users.length === 0" class="flex flex-1 flex-col items-center justify-center gap-3 py-20 text-center text-muted-foreground">
      <AppIcon name="users" size="xl" class="h-10 w-10 opacity-40" />
      <p class="text-sm">{{ $t('users.empty') }}</p>
    </div>

    <!-- Users table -->
    <div v-else class="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      <div class="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow class="hover:bg-transparent">
              <TableHead>{{ $t('users.columns.username') }}</TableHead>
              <TableHead>{{ $t('users.columns.role') }}</TableHead>
              <TableHead>{{ $t('users.columns.telegram') }}</TableHead>
              <TableHead>{{ $t('users.columns.createdAt') }}</TableHead>
              <TableHead class="text-right">{{ $t('users.columns.actions') }}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="entry in users" :key="entry.id">
              <!-- Username + avatar -->
              <TableCell>
                <div class="flex items-center gap-3">
                  <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-bold text-primary">
                    {{ entry.username.slice(0, 1).toUpperCase() }}
                  </span>
                  <div class="min-w-0">
                    <div class="flex items-center gap-2">
                      <span class="font-semibold text-foreground">{{ entry.username }}</span>
                      <Badge v-if="entry.id === currentUserId" variant="secondary" class="px-1.5 py-0 text-[10px]">
                        {{ $t('users.you') }}
                      </Badge>
                    </div>
                    <span class="text-xs text-muted-foreground">
                      {{ $t('users.updatedAt', { date: formatDate(entry.updatedAt) }) }}
                    </span>
                  </div>
                </div>
              </TableCell>

              <!-- Role -->
              <TableCell>
                <Badge :variant="entry.role === 'admin' ? 'warning' : 'success'">
                  {{ entry.role === 'admin' ? $t('roles.admin') : $t('roles.user') }}
                </Badge>
              </TableCell>

              <!-- Telegram -->
              <TableCell>
                <span v-if="entry.telegramId" class="font-mono text-xs text-foreground">{{ entry.telegramId }}</span>
                <span v-else class="text-xs text-muted-foreground">{{ $t('users.notLinked') }}</span>
              </TableCell>

              <!-- Created -->
              <TableCell class="text-sm text-muted-foreground">
                {{ formatDate(entry.createdAt) }}
              </TableCell>

              <!-- Actions -->
              <TableCell class="text-right">
                <div class="flex items-center justify-end gap-2">
                  <Button variant="outline" size="sm" @click="openEditModal(entry)">
                    {{ $t('users.edit') }}
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    :disabled="entry.id === currentUserId || actionPending"
                    @click="openDeleteModal(entry)"
                  >
                    {{ $t('users.delete') }}
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
    </div>
  </div>

  <!-- Add / Edit dialog -->
  <Dialog :open="showModal" @update:open="(v: boolean) => { if (!v) closeModal() }">
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{{ mode === 'create' ? $t('users.addUser') : $t('users.editUser') }}</DialogTitle>
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
          <Select id="modal-role" v-model="form.role">
            <option value="user">{{ $t('roles.user') }}</option>
            <option value="admin">{{ $t('roles.admin') }}</option>
          </Select>
        </div>

        <!-- Password -->
        <div class="flex flex-col gap-1.5">
          <Label for="modal-password">{{ mode === 'create' ? $t('users.password') : $t('users.resetPassword') }}</Label>
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
          <Button type="button" variant="outline" @click="closeModal">{{ $t('common.cancel') }}</Button>
          <Button type="submit" :disabled="actionPending">
            <span
              v-if="actionPending"
              class="mr-1 h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground/30 border-t-primary-foreground"
              aria-hidden="true"
            />
            {{ $t('common.save') }}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>

  <!-- Delete confirmation dialog -->
  <Dialog :open="!!deleteTarget" @update:open="(v: boolean) => { if (!v) deleteTarget = null }">
    <DialogContent class="max-w-sm">
      <DialogHeader>
        <DialogTitle>{{ $t('users.delete') }}</DialogTitle>
        <DialogDescription>
          {{ $t('users.deleteConfirm', { username: deleteTarget?.username ?? '' }) }}
        </DialogDescription>
      </DialogHeader>

      <DialogFooter>
        <Button variant="outline" @click="deleteTarget = null">{{ $t('common.cancel') }}</Button>
        <Button variant="destructive" :disabled="actionPending" @click="handleDelete">
          <span
            v-if="actionPending"
            class="mr-1 h-4 w-4 animate-spin rounded-full border-2 border-destructive-foreground/30 border-t-destructive-foreground"
            aria-hidden="true"
          />
          {{ $t('users.delete') }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import type { User } from '~/composables/useUsers'

const { t } = useI18n()
const { user } = useAuth()
const isAdmin = computed(() => user.value?.role === 'admin')
const currentUserId = computed(() => user.value?.id ?? -1)

const { users, loading, error, fetchUsers, createUser, updateUser, deleteUser } = useUsers()

const showModal = ref(false)
const mode = ref<'create' | 'edit'>('create')
const editingUserId = ref<number | null>(null)
const deleteTarget = ref<User | null>(null)
const actionPending = ref(false)
const successMessage = ref<string | null>(null)
const localError = ref<string | null>(null)

const form = reactive({
  username: '',
  password: '',
  role: 'user',
})

const errorMessage = computed(() => localError.value || error.value)

onMounted(async () => {
  if (!isAdmin.value) return
  await fetchUsers()
})

function clearMessages() {
  localError.value = null
  successMessage.value = null
  error.value = null
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

function openCreateModal() {
  clearMessages()
  mode.value = 'create'
  editingUserId.value = null
  form.username = ''
  form.password = ''
  form.role = 'user'
  showModal.value = true
}

function openEditModal(entry: User) {
  clearMessages()
  mode.value = 'edit'
  editingUserId.value = entry.id
  form.username = entry.username
  form.password = ''
  form.role = entry.role
  showModal.value = true
}

function closeModal() {
  showModal.value = false
  editingUserId.value = null
  form.password = ''
}

function openDeleteModal(entry: User) {
  clearMessages()
  deleteTarget.value = entry
}

async function handleSubmit() {
  clearMessages()
  actionPending.value = true

  let success = false
  if (mode.value === 'create') {
    success = await createUser(form.username, form.password, form.role)
    if (success) {
      successMessage.value = t('users.createSuccess')
    }
  } else if (editingUserId.value !== null) {
    const updates: { role?: string; password?: string } = { role: form.role }
    if (form.password.trim()) {
      updates.password = form.password.trim()
    }
    success = await updateUser(editingUserId.value, updates)
    if (success) {
      successMessage.value = t('users.updateSuccess')
    }
  }

  if (!success) {
    localError.value = error.value || t('common.saveFailed')
  } else {
    closeModal()
    autoHideSuccess()
  }

  actionPending.value = false
}

async function handleDelete() {
  if (!deleteTarget.value) return
  clearMessages()
  actionPending.value = true

  const success = await deleteUser(deleteTarget.value.id)
  if (success) {
    successMessage.value = t('users.deleteSuccess')
    deleteTarget.value = null
    autoHideSuccess()
  } else {
    localError.value = error.value || t('common.deleteFailed')
  }

  actionPending.value = false
}

function autoHideSuccess() {
  setTimeout(() => {
    successMessage.value = null
  }, 3000)
}
</script>
