<template>
  <div v-if="!isAdmin" class="admin-gate">
    <span class="gate-icon">🔒</span>
    <h1>{{ $t('admin.title') }}</h1>
    <p>{{ $t('admin.description') }}</p>
  </div>

  <div v-else class="settings-page">
    <div class="settings-header">
      <div>
        <p class="eyebrow">{{ $t('settings.kicker') }}</p>
        <h1>{{ $t('settings.title') }}</h1>
        <p class="settings-subtitle">{{ $t('settings.subtitle') }}</p>
      </div>
    </div>

    <div v-if="error" class="error-banner">
      {{ error }}
      <button class="error-dismiss" @click="clearMessages()">✕</button>
    </div>
    <div v-if="successMessage" class="success-banner">
      {{ $t('settings.saveSuccess') }}
      <button class="success-dismiss" @click="clearMessages()">✕</button>
    </div>

    <div v-if="loading" class="loading-state">{{ $t('settings.loading') }}</div>

    <div v-else-if="form" class="settings-form">
      <section class="form-section glass">
        <div class="section-head">
          <div>
            <h2>{{ $t('settings.sessionSection') }}</h2>
            <p>{{ $t('settings.sessionSectionDescription') }}</p>
          </div>
        </div>

        <div class="form-grid single">
          <div class="form-group">
            <label>{{ $t('settings.sessionTimeout') }}</label>
            <div class="input-with-unit">
              <input
                v-model.number="form.sessionTimeoutMinutes"
                type="number"
                min="1"
                max="1440"
              />
              <span class="input-unit">{{ $t('settings.minutes') }}</span>
            </div>
            <small class="form-hint">{{ $t('settings.sessionTimeoutHint') }}</small>
          </div>
        </div>
      </section>

      <section class="form-section glass">
        <div class="section-head">
          <div>
            <h2>{{ $t('settings.languageSection') }}</h2>
            <p>{{ $t('settings.languageSectionDescription') }}</p>
          </div>
        </div>

        <div class="form-grid single">
          <div class="form-group">
            <label>{{ $t('settings.language') }}</label>
            <select v-model="form.language">
              <option value="match">{{ $t('settings.languageMatch') }}</option>
              <option value="English">{{ $t('settings.languages.english') }}</option>
              <option value="German">{{ $t('settings.languages.german') }}</option>
              <option value="French">{{ $t('settings.languages.french') }}</option>
              <option value="Spanish">{{ $t('settings.languages.spanish') }}</option>
              <option value="Italian">{{ $t('settings.languages.italian') }}</option>
              <option value="Portuguese">{{ $t('settings.languages.portuguese') }}</option>
              <option value="Dutch">{{ $t('settings.languages.dutch') }}</option>
              <option value="Russian">{{ $t('settings.languages.russian') }}</option>
              <option value="Chinese">{{ $t('settings.languages.chinese') }}</option>
              <option value="Japanese">{{ $t('settings.languages.japanese') }}</option>
              <option value="Korean">{{ $t('settings.languages.korean') }}</option>
            </select>
            <small class="form-hint">{{ $t('settings.languageHint') }}</small>
          </div>
        </div>
      </section>

      <section class="form-section glass">
        <div class="section-head">
          <div>
            <h2>{{ $t('settings.agentSection') }}</h2>
            <p>{{ $t('settings.agentSectionDescription') }}</p>
          </div>
        </div>

        <div class="form-grid">
          <div class="form-group">
            <label>{{ $t('settings.heartbeatInterval') }}</label>
            <div class="input-with-unit">
              <input
                v-model.number="form.heartbeatIntervalMinutes"
                type="number"
                min="1"
                max="60"
              />
              <span class="input-unit">{{ $t('settings.minutes') }}</span>
            </div>
            <small class="form-hint">{{ $t('settings.heartbeatHint') }}</small>
          </div>

          <div class="form-group">
            <label>{{ $t('settings.batchingDelay') }}</label>
            <div class="input-with-unit">
              <input
                v-model.number="form.batchingDelayMs"
                type="number"
                min="0"
                max="10000"
                step="100"
              />
              <span class="input-unit">ms</span>
            </div>
            <small class="form-hint">{{ $t('settings.batchingDelayHint') }}</small>
          </div>
        </div>
      </section>

      <section class="form-section glass">
        <div class="section-head">
          <div>
            <h2>{{ $t('settings.telegramSection') }}</h2>
            <p>{{ $t('settings.telegramSectionDescription') }}</p>
          </div>
        </div>

        <div class="form-grid single">
          <div class="form-group">
            <label>{{ $t('settings.telegramBotToken') }}</label>
            <input
              v-model="form.telegramBotToken"
              type="password"
              autocomplete="off"
              :placeholder="$t('settings.telegramBotTokenPlaceholder')"
            />
            <small class="form-hint">{{ $t('settings.telegramBotTokenHint') }}</small>
          </div>
        </div>
      </section>

      <div class="form-actions">
        <button class="btn btn-primary" :disabled="saving" @click="handleSave">
          <span v-if="saving" class="spinner" />
          {{ $t('settings.save') }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
const { user } = useAuth()
const isAdmin = computed(() => user.value?.role === 'admin')

const {
  settings,
  loading,
  saving,
  error,
  successMessage,
  fetchSettings,
  updateSettings,
  clearMessages,
} = useSettings()

const form = ref<{
  sessionTimeoutMinutes: number
  language: string
  heartbeatIntervalMinutes: number
  batchingDelayMs: number
  telegramBotToken: string
} | null>(null)

onMounted(async () => {
  if (!isAdmin.value) return
  await fetchSettings()
  hydrateForm()
})

watch(settings, () => {
  hydrateForm()
})

function hydrateForm() {
  if (!settings.value) return
  form.value = {
    sessionTimeoutMinutes: settings.value.sessionTimeoutMinutes,
    language: settings.value.language,
    heartbeatIntervalMinutes: settings.value.heartbeatIntervalMinutes,
    batchingDelayMs: settings.value.batchingDelayMs,
    telegramBotToken: settings.value.telegramBotToken,
  }
}

async function handleSave() {
  if (!form.value) return
  const success = await updateSettings(form.value)
  if (!success) return

  hydrateForm()
  setTimeout(() => {
    successMessage.value = null
  }, 3000)
}
</script>

<style scoped>
.settings-page {
  padding: 28px;
  max-width: 860px;
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

.settings-header {
  margin-bottom: 24px;
}

.eyebrow {
  font-size: 12px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: #a5b4fc;
  margin-bottom: 8px;
}

.settings-header h1 {
  font-size: 28px;
  font-weight: 700;
  color: var(--color-text);
  margin: 0;
}

.settings-subtitle {
  margin-top: 8px;
  color: var(--color-text-secondary);
  max-width: 640px;
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
  font-size: 16px;
}

.loading-state {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 80px 20px;
  color: var(--color-text-muted);
}

.settings-form {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.glass {
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.03), rgba(255, 255, 255, 0.01)),
    var(--color-bg-secondary);
  border: 1px solid rgba(255, 255, 255, 0.06);
  box-shadow: 0 14px 30px rgba(0, 0, 0, 0.16);
}

.form-section {
  border-radius: 18px;
  padding: 22px;
}

.section-head {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 18px;
}

.section-head h2 {
  font-size: 17px;
  font-weight: 600;
  color: var(--color-text);
  margin: 0;
}

.section-head p {
  margin-top: 6px;
  font-size: 13px;
  color: var(--color-text-muted);
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

.form-grid.single {
  grid-template-columns: minmax(0, 1fr);
}

.form-group label {
  display: block;
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-secondary);
  margin-bottom: 8px;
}

.form-group input,
.form-group select {
  width: 100%;
  padding: 11px 12px;
  background: rgba(15, 17, 23, 0.7);
  border: 1px solid var(--color-border);
  border-radius: 10px;
  color: var(--color-text);
  font-size: 14px;
  outline: none;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.form-group input:focus,
.form-group select:focus {
  border-color: var(--color-primary);
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.12);
}

.input-with-unit {
  display: flex;
  gap: 10px;
  align-items: center;
}

.input-with-unit input {
  width: 150px;
  flex-shrink: 0;
}

.input-unit {
  font-size: 13px;
  color: var(--color-text-muted);
}

.form-hint {
  display: block;
  font-size: 12px;
  color: var(--color-text-muted);
  margin-top: 6px;
  line-height: 1.5;
}

.form-actions {
  display: flex;
  justify-content: flex-end;
  padding-top: 6px;
}

.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 10px 18px;
  border-radius: 10px;
  font-size: 14px;
  font-weight: 600;
  border: none;
  cursor: pointer;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-primary {
  background: linear-gradient(135deg, var(--color-primary), #8b5cf6);
  color: white;
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

@media (max-width: 768px) {
  .settings-page {
    padding: 18px;
  }

  .form-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .input-with-unit input {
    width: 120px;
  }
}
</style>
