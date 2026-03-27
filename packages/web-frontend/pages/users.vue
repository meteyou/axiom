<template>
  <div v-if="!isAdmin" class="admin-gate">
    <span class="gate-icon">🔒</span>
    <h1>{{ $t('admin.title') }}</h1>
    <p>{{ $t('admin.description') }}</p>
  </div>

  <div v-else class="users-page">
    <div class="users-header">
      <div>
        <p class="eyebrow">{{ $t('users.kicker') }}</p>
        <h1>{{ $t('users.title') }}</h1>
        <p class="users-subtitle">{{ $t('users.subtitle') }}</p>
      </div>
      <button class="btn btn-primary" @click="openCreateModal">
        <span class="btn-icon">+</span>
        {{ $t('users.addUser') }}
      </button>
    </div>

    <div v-if="errorMessage" class="error-banner">
      {{ errorMessage }}
      <button class="error-dismiss" @click="clearMessages">✕</button>
    </div>
    <div v-if="successMessage" class="success-banner">
      {{ successMessage }}
      <button class="success-dismiss" @click="clearMessages">✕</button>
    </div>

    <div v-if="loading && users.length === 0" class="loading-state">{{ $t('users.loading') }}</div>

    <div v-else-if="users.length === 0" class="empty-state">
      <span class="empty-icon">👥</span>
      <p>{{ $t('users.empty') }}</p>
    </div>

    <div v-else class="users-table-wrap glass">
      <table class="users-table">
        <thead>
          <tr>
            <th>{{ $t('users.columns.username') }}</th>
            <th>{{ $t('users.columns.role') }}</th>
            <th>{{ $t('users.columns.telegram') }}</th>
            <th>{{ $t('users.columns.createdAt') }}</th>
            <th>{{ $t('users.columns.actions') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="entry in users" :key="entry.id">
            <td>
              <div class="user-cell">
                <span class="user-dot">{{ entry.username.slice(0, 1).toUpperCase() }}</span>
                <div>
                  <div class="username-row">
                    <span class="username">{{ entry.username }}</span>
                    <span v-if="entry.id === currentUserId" class="self-pill">{{ $t('users.you') }}</span>
                  </div>
                  <span class="user-updated">{{ $t('users.updatedAt', { date: formatDate(entry.updatedAt) }) }}</span>
                </div>
              </div>
            </td>
            <td>
              <span class="role-badge" :class="entry.role">{{ entry.role === 'admin' ? $t('roles.admin') : $t('roles.user') }}</span>
            </td>
            <td>
              <span v-if="entry.telegramId" class="telegram-linked">{{ entry.telegramId }}</span>
              <span v-else class="telegram-empty">{{ $t('users.notLinked') }}</span>
            </td>
            <td>{{ formatDate(entry.createdAt) }}</td>
            <td>
              <div class="table-actions">
                <button class="btn btn-sm btn-outline" @click="openEditModal(entry)">{{ $t('users.edit') }}</button>
                <button
                  class="btn btn-sm btn-outline btn-danger"
                  :disabled="entry.id === currentUserId || actionPending"
                  @click="openDeleteModal(entry)"
                >{{ $t('users.delete') }}</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="showModal" class="modal-overlay" @click.self="closeModal">
      <div class="modal glass">
        <h2>{{ mode === 'create' ? $t('users.addUser') : $t('users.editUser') }}</h2>

        <form @submit.prevent="handleSubmit">
          <div v-if="mode === 'create'" class="form-group">
            <label>{{ $t('users.username') }}</label>
            <input v-model="form.username" type="text" autocomplete="username" required />
          </div>

          <div class="form-group">
            <label>{{ $t('users.role') }}</label>
            <select v-model="form.role">
              <option value="user">{{ $t('roles.user') }}</option>
              <option value="admin">{{ $t('roles.admin') }}</option>
            </select>
          </div>

          <div class="form-group">
            <label>{{ mode === 'create' ? $t('users.password') : $t('users.resetPassword') }}</label>
            <input
              v-model="form.password"
              type="password"
              autocomplete="new-password"
              :required="mode === 'create'"
              :placeholder="mode === 'create' ? $t('users.passwordPlaceholder') : $t('users.passwordOptional')"
            />
            <small class="form-hint">{{ mode === 'create' ? $t('users.passwordHint') : $t('users.passwordResetHint') }}</small>
          </div>

          <div class="form-actions">
            <button type="button" class="btn btn-outline" @click="closeModal">{{ $t('common.cancel') }}</button>
            <button type="submit" class="btn btn-primary" :disabled="actionPending">
              <span v-if="actionPending" class="spinner" />
              {{ $t('common.save') }}
            </button>
          </div>
        </form>
      </div>
    </div>

    <div v-if="deleteTarget" class="modal-overlay" @click.self="deleteTarget = null">
      <div class="modal modal-sm glass">
        <h2>{{ $t('users.delete') }}</h2>
        <p>{{ $t('users.deleteConfirm', { username: deleteTarget.username }) }}</p>
        <div class="form-actions">
          <button class="btn btn-outline" @click="deleteTarget = null">{{ $t('common.cancel') }}</button>
          <button class="btn btn-danger" :disabled="actionPending" @click="handleDelete">
            <span v-if="actionPending" class="spinner" />
            {{ $t('users.delete') }}
          </button>
        </div>
      </div>
    </div>
  </div>
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

<style scoped>
.users-page {
  padding: 24px;
  max-width: 1180px;
  margin: 0 auto;
  height: 100%;
  overflow-y: auto;
}

.admin-gate {
  display: grid;
  place-items: center;
  gap: 10px;
  padding: 40px;
  height: 100%;
  color: var(--color-text-muted);
  text-align: center;
}

.gate-icon {
  font-size: 44px;
}

.users-header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 24px;
}

.eyebrow {
  font-size: 12px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: #a5b4fc;
  margin-bottom: 8px;
}

.users-header h1 {
  font-size: 28px;
  margin: 0;
}

.users-subtitle {
  margin-top: 8px;
  color: var(--color-text-secondary);
}

.glass {
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.03), rgba(255, 255, 255, 0.01)),
    var(--color-bg-secondary);
  border: 1px solid rgba(255, 255, 255, 0.06);
  box-shadow: 0 14px 30px rgba(0, 0, 0, 0.16);
}

.error-banner,
.success-banner {
  padding: 12px 16px;
  border-radius: 12px;
  margin-bottom: 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 14px;
}

.error-banner {
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid var(--color-error, #ef4444);
  color: var(--color-error, #ef4444);
}

.success-banner {
  background: rgba(34, 197, 94, 0.1);
  border: 1px solid rgba(34, 197, 94, 0.25);
  color: #4ade80;
}

.error-dismiss,
.success-dismiss {
  background: none;
  border: none;
  color: inherit;
}

.loading-state,
.empty-state {
  display: grid;
  place-items: center;
  gap: 12px;
  padding: 70px 20px;
  color: var(--color-text-muted);
}

.empty-icon {
  font-size: 44px;
}

.users-table-wrap {
  border-radius: 18px;
  overflow: hidden;
}

.users-table {
  width: 100%;
  border-collapse: collapse;
}

.users-table th,
.users-table td {
  padding: 16px;
  text-align: left;
  font-size: 14px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}

.users-table th {
  font-size: 12px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--color-text-muted);
}

.user-cell {
  display: flex;
  align-items: center;
  gap: 12px;
}

.user-dot {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: rgba(99, 102, 241, 0.14);
  color: #c7d2fe;
  font-weight: 700;
}

.username-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.username {
  font-weight: 600;
  color: var(--color-text);
}

.self-pill {
  display: inline-flex;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  background: rgba(99, 102, 241, 0.14);
  color: #c7d2fe;
}

.user-updated,
.telegram-empty {
  font-size: 12px;
  color: var(--color-text-muted);
}

.telegram-linked {
  color: var(--color-text);
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 13px;
}

.role-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 6px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.role-badge.admin {
  background: rgba(245, 158, 11, 0.14);
  color: #fbbf24;
}

.role-badge.user {
  background: rgba(34, 197, 94, 0.14);
  color: #4ade80;
}

.table-actions {
  display: flex;
  gap: 8px;
}

.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 10px 16px;
  border-radius: 10px;
  font-size: 14px;
  font-weight: 600;
  border: none;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-primary {
  background: linear-gradient(135deg, var(--color-primary), #8b5cf6);
  color: white;
}

.btn-outline {
  background: transparent;
  border: 1px solid var(--color-border);
  color: var(--color-text-secondary);
}

.btn-outline:hover:not(:disabled) {
  background: var(--color-bg-tertiary);
  color: var(--color-text);
}

.btn-danger {
  background: #ef4444;
  color: white;
}

.btn-outline.btn-danger {
  background: transparent;
  color: #f87171;
  border-color: rgba(239, 68, 68, 0.28);
}

.btn-sm {
  padding: 7px 10px;
  font-size: 13px;
}

.btn-icon {
  font-size: 18px;
  line-height: 1;
}

.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 500;
  padding: 20px;
}

.modal {
  width: 100%;
  max-width: 500px;
  border-radius: 20px;
  padding: 24px;
}

.modal-sm {
  max-width: 420px;
}

.modal h2 {
  margin: 0 0 18px;
  font-size: 20px;
}

.modal p {
  color: var(--color-text-secondary);
  line-height: 1.6;
}

.form-group {
  margin-bottom: 16px;
}

.form-group label {
  display: block;
  margin-bottom: 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-secondary);
}

.form-group input,
.form-group select {
  width: 100%;
  padding: 11px 12px;
  background: rgba(15, 17, 23, 0.76);
  border: 1px solid var(--color-border);
  border-radius: 10px;
  color: var(--color-text);
}

.form-hint {
  display: block;
  margin-top: 6px;
  color: var(--color-text-muted);
  font-size: 12px;
}

.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 24px;
}

.spinner {
  width: 14px;
  height: 14px;
  border: 2px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

@media (max-width: 860px) {
  .users-page {
    padding: 16px;
  }

  .users-header {
    flex-direction: column;
    align-items: flex-start;
  }

  .users-table-wrap {
    overflow-x: auto;
  }
}
</style>
