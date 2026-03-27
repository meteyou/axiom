<template>
  <div class="providers-page">
    <div class="providers-header">
      <h1>{{ $t('providers.title') }}</h1>
      <button class="btn btn-primary" @click="openAddForm">
        <span class="btn-icon">+</span>
        {{ $t('providers.addProvider') }}
      </button>
    </div>

    <!-- Error banner -->
    <div v-if="error" class="error-banner">
      {{ error }}
      <button class="error-dismiss" @click="error = null">✕</button>
    </div>

    <!-- Loading state -->
    <div v-if="loading && providers.length === 0" class="loading-state">
      {{ $t('logs.loading') }}
    </div>

    <!-- Empty state -->
    <div v-else-if="providers.length === 0 && !showForm" class="empty-state">
      <span class="empty-icon">🔌</span>
      <p>{{ $t('providers.noProviders') }}</p>
      <button class="btn btn-primary" @click="openAddForm">
        {{ $t('providers.addProvider') }}
      </button>
    </div>

    <!-- Provider list -->
    <div v-else class="providers-list">
      <div
        v-for="provider in providers"
        :key="provider.id"
        class="provider-card"
        :class="{
          active: provider.id === activeProviderId,
          editing: editingId === provider.id,
        }"
      >
        <div class="provider-card-header">
          <div class="provider-info">
            <div class="provider-name-row">
              <h3 class="provider-name">{{ provider.name }}</h3>
              <span
                v-if="provider.id === activeProviderId"
                class="badge badge-active"
              >{{ $t('providers.active') }}</span>
              <span
                class="badge"
                :class="statusBadgeClass(provider.status)"
              >{{ statusLabel(provider.status) }}</span>
            </div>
            <div class="provider-meta">
              <span class="meta-item">{{ providerTypeLabel(provider.providerType) }}</span>
              <span class="meta-sep">·</span>
              <span class="meta-item">{{ provider.defaultModel }}</span>
              <span class="meta-sep">·</span>
              <span class="meta-item meta-url">{{ provider.baseUrl }}</span>
            </div>
          </div>

          <div class="provider-actions">
            <button
              class="btn btn-sm btn-outline"
              :disabled="testingId === provider.id"
              @click="handleTest(provider.id)"
            >
              <span v-if="testingId === provider.id" class="spinner" />
              {{ testingId === provider.id ? $t('providers.testing') : $t('providers.testConnection') }}
            </button>
            <button
              v-if="provider.id !== activeProviderId"
              class="btn btn-sm btn-outline"
              @click="handleActivate(provider.id)"
            >
              {{ $t('providers.setActive') }}
            </button>
            <button
              class="btn btn-sm btn-outline"
              @click="openEditForm(provider)"
            >✏️</button>
            <button
              class="btn btn-sm btn-outline btn-danger"
              :disabled="provider.id === activeProviderId"
              :title="provider.id === activeProviderId ? $t('providers.cannotDeleteActive') : $t('providers.delete')"
              @click="confirmDelete(provider)"
            >🗑️</button>
          </div>
        </div>

        <!-- Test result feedback -->
        <div v-if="testResults[provider.id]" class="test-result" :class="{ success: testResults[provider.id].success, error: !testResults[provider.id].success }">
          {{ testResults[provider.id].success ? testResults[provider.id].message : testResults[provider.id].error }}
        </div>
      </div>
    </div>

    <!-- Add/Edit form modal -->
    <div v-if="showForm" class="modal-overlay" @click.self="closeForm">
      <div class="modal">
        <h2>{{ isEditing ? $t('providers.editProvider') : $t('providers.addProvider') }}</h2>

        <form @submit.prevent="handleSubmit">
          <div class="form-group">
            <label>{{ $t('providers.name') }}</label>
            <input
              v-model="form.name"
              type="text"
              :placeholder="$t('providers.namePlaceholder')"
              required
            />
          </div>

          <div class="form-group">
            <label>{{ $t('providers.type') }}</label>
            <select v-model="form.providerType" required @change="onTypeChange">
              <option value="" disabled>{{ $t('providers.selectType') }}</option>
              <option v-for="(preset, key) in presets" :key="key" :value="key">
                {{ preset.label }}
              </option>
            </select>
          </div>

          <div class="form-group">
            <label>{{ $t('providers.baseUrl') }}</label>
            <input
              v-model="form.baseUrl"
              type="url"
              placeholder="https://..."
            />
          </div>

          <div class="form-group">
            <label>{{ $t('providers.apiKey') }}</label>
            <input
              v-model="form.apiKey"
              type="password"
              :placeholder="isEditing ? $t('providers.apiKeyHint') : $t('providers.apiKeyPlaceholder')"
            />
            <small v-if="isEditing" class="form-hint">{{ $t('providers.apiKeyHint') }}</small>
          </div>

          <div class="form-group">
            <label>{{ $t('providers.model') }}</label>
            <input
              v-model="form.defaultModel"
              type="text"
              :placeholder="$t('providers.modelPlaceholder')"
              required
            />
          </div>

          <div class="form-actions">
            <button type="button" class="btn btn-outline" @click="closeForm">
              {{ $t('providers.cancel') }}
            </button>
            <button type="submit" class="btn btn-primary">
              {{ $t('providers.save') }}
            </button>
          </div>
        </form>
      </div>
    </div>

    <!-- Delete confirmation dialog -->
    <div v-if="deleteTarget" class="modal-overlay" @click.self="deleteTarget = null">
      <div class="modal modal-sm">
        <h2>{{ $t('providers.delete') }}</h2>
        <p>{{ $t('providers.deleteConfirm', { name: deleteTarget.name }) }}</p>
        <div class="form-actions">
          <button class="btn btn-outline" @click="deleteTarget = null">
            {{ $t('providers.deleteCancel') }}
          </button>
          <button class="btn btn-danger" @click="handleDelete">
            {{ $t('providers.deleteConfirmButton') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { Provider, ProviderTypePreset } from '~/composables/useProviders'

const { t } = useI18n()
const {
  providers,
  activeProviderId,
  presets,
  loading,
  error,
  testingId,
  fetchProviders,
  addProvider,
  updateProvider,
  deleteProvider,
  testProvider,
  activateProvider,
} = useProviders()

// Form state
const showForm = ref(false)
const isEditing = ref(false)
const editingId = ref<string | null>(null)
const deleteTarget = ref<Provider | null>(null)
const testResults = ref<Record<string, { success: boolean; message?: string; error?: string }>>({})

const form = reactive({
  name: '',
  providerType: '',
  baseUrl: '',
  apiKey: '',
  defaultModel: '',
})

// Fetch on mount
onMounted(() => {
  fetchProviders()
})

function providerTypeLabel(type: string): string {
  const preset = presets.value[type]
  return preset?.label ?? type
}

function statusBadgeClass(status?: string): string {
  switch (status) {
    case 'connected': return 'badge-success'
    case 'error': return 'badge-error'
    default: return 'badge-untested'
  }
}

function statusLabel(status?: string): string {
  switch (status) {
    case 'connected': return t('providers.statusConnected')
    case 'error': return t('providers.statusError')
    default: return t('providers.statusUntested')
  }
}

function openAddForm() {
  isEditing.value = false
  editingId.value = null
  form.name = ''
  form.providerType = ''
  form.baseUrl = ''
  form.apiKey = ''
  form.defaultModel = ''
  showForm.value = true
}

function openEditForm(provider: Provider) {
  isEditing.value = true
  editingId.value = provider.id
  form.name = provider.name
  form.providerType = provider.providerType
  form.baseUrl = provider.baseUrl
  form.apiKey = ''
  form.defaultModel = provider.defaultModel
  showForm.value = true
}

function closeForm() {
  showForm.value = false
  editingId.value = null
}

function onTypeChange() {
  const preset = presets.value[form.providerType]
  if (preset && !isEditing.value) {
    form.baseUrl = preset.baseUrl
  }
}

async function handleSubmit() {
  if (isEditing.value && editingId.value) {
    const input: Record<string, string | undefined> = {
      name: form.name,
      providerType: form.providerType,
      baseUrl: form.baseUrl,
      defaultModel: form.defaultModel,
    }
    // Only send apiKey if it was changed
    if (form.apiKey) {
      input.apiKey = form.apiKey
    }
    const result = await updateProvider(editingId.value, input)
    if (result) closeForm()
  } else {
    const result = await addProvider({
      name: form.name,
      providerType: form.providerType,
      baseUrl: form.baseUrl || undefined,
      apiKey: form.apiKey || undefined,
      defaultModel: form.defaultModel,
    })
    if (result) closeForm()
  }
}

function confirmDelete(provider: Provider) {
  deleteTarget.value = provider
}

async function handleDelete() {
  if (!deleteTarget.value) return
  const success = await deleteProvider(deleteTarget.value.id)
  if (success) {
    deleteTarget.value = null
  }
}

async function handleTest(id: string) {
  const result = await testProvider(id)
  testResults.value[id] = result
  // Auto-dismiss after 5s
  setTimeout(() => {
    delete testResults.value[id]
  }, 5000)
}

async function handleActivate(id: string) {
  await activateProvider(id)
}
</script>

<style scoped>
.providers-page {
  padding: 24px;
  max-width: 900px;
  margin: 0 auto;
  height: 100%;
  overflow-y: auto;
}

.providers-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 24px;
}

.providers-header h1 {
  font-size: 24px;
  font-weight: 700;
  color: var(--color-text);
  margin: 0;
}

/* Error banner */
.error-banner {
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid var(--color-error, #ef4444);
  color: var(--color-error, #ef4444);
  padding: 12px 16px;
  border-radius: 8px;
  margin-bottom: 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 14px;
}

.error-dismiss {
  background: none;
  border: none;
  color: inherit;
  cursor: pointer;
  font-size: 16px;
  padding: 0 4px;
}

/* Loading & empty states */
.loading-state,
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 60px 20px;
  color: var(--color-text-muted);
  gap: 16px;
}

.empty-icon {
  font-size: 48px;
  opacity: 0.5;
}

/* Provider cards */
.providers-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.provider-card {
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: 12px;
  padding: 16px 20px;
  transition: border-color 0.15s ease;
}

.provider-card.active {
  border-color: var(--color-primary);
  box-shadow: 0 0 0 1px var(--color-primary);
}

.provider-card-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.provider-info {
  flex: 1;
  min-width: 0;
}

.provider-name-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.provider-name {
  font-size: 16px;
  font-weight: 600;
  color: var(--color-text);
  margin: 0;
}

.provider-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  font-size: 13px;
  color: var(--color-text-secondary);
  flex-wrap: wrap;
}

.meta-sep {
  opacity: 0.4;
}

.meta-url {
  word-break: break-all;
}

.provider-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  flex-wrap: wrap;
}

/* Test result */
.test-result {
  margin-top: 12px;
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 13px;
}

.test-result.success {
  background: rgba(34, 197, 94, 0.1);
  color: #22c55e;
  border: 1px solid rgba(34, 197, 94, 0.2);
}

.test-result.error {
  background: rgba(239, 68, 68, 0.1);
  color: #ef4444;
  border: 1px solid rgba(239, 68, 68, 0.2);
}

/* Badges */
.badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 12px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.badge-active {
  background: rgba(99, 102, 241, 0.15);
  color: var(--color-primary);
}

.badge-success {
  background: rgba(34, 197, 94, 0.15);
  color: #22c55e;
}

.badge-error {
  background: rgba(239, 68, 68, 0.15);
  color: #ef4444;
}

.badge-untested {
  background: rgba(156, 163, 175, 0.15);
  color: var(--color-text-muted);
}

/* Buttons */
.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  border: none;
  cursor: pointer;
  transition: all 0.15s ease;
  white-space: nowrap;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-primary {
  background: var(--color-primary);
  color: white;
}

.btn-primary:hover:not(:disabled) {
  opacity: 0.9;
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
  border: none;
}

.btn-danger:hover:not(:disabled) {
  background: #dc2626;
}

.btn-outline.btn-danger {
  background: transparent;
  border: 1px solid rgba(239, 68, 68, 0.3);
  color: #ef4444;
}

.btn-outline.btn-danger:hover:not(:disabled) {
  background: rgba(239, 68, 68, 0.1);
}

.btn-sm {
  padding: 5px 10px;
  font-size: 13px;
}

.btn-icon {
  font-size: 18px;
  line-height: 1;
}

/* Spinner */
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

/* Modal */
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
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: 16px;
  padding: 24px;
  width: 100%;
  max-width: 500px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
}

.modal-sm {
  max-width: 400px;
}

.modal h2 {
  font-size: 18px;
  font-weight: 600;
  color: var(--color-text);
  margin: 0 0 20px;
}

.modal p {
  font-size: 14px;
  color: var(--color-text-secondary);
  margin: 0 0 20px;
  line-height: 1.5;
}

/* Form */
.form-group {
  margin-bottom: 16px;
}

.form-group label {
  display: block;
  font-size: 13px;
  font-weight: 500;
  color: var(--color-text-secondary);
  margin-bottom: 6px;
}

.form-group input,
.form-group select {
  width: 100%;
  padding: 10px 12px;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  color: var(--color-text);
  font-size: 14px;
  outline: none;
  transition: border-color 0.15s ease;
}

.form-group input:focus,
.form-group select:focus {
  border-color: var(--color-primary);
}

.form-group select {
  appearance: auto;
}

.form-hint {
  display: block;
  font-size: 12px;
  color: var(--color-text-muted);
  margin-top: 4px;
}

.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 24px;
}

/* Responsive */
@media (max-width: 768px) {
  .providers-page {
    padding: 16px;
  }

  .provider-card-header {
    flex-direction: column;
  }

  .provider-actions {
    margin-top: 12px;
  }

  .providers-header {
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
  }
}
</style>
