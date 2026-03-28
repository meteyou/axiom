<template>
  <!-- Admin gate -->
  <div v-if="!isAdmin" class="flex h-full flex-col items-center justify-center gap-3 p-10 text-center text-muted-foreground">
    <AppIcon name="lock" size="xl" />
    <h1 class="text-xl font-semibold text-foreground">{{ $t('admin.title') }}</h1>
    <p class="text-sm">{{ $t('admin.description') }}</p>
  </div>

  <!-- Settings page -->
  <div v-else class="flex h-full flex-col overflow-hidden">
    <!-- Header with save action -->
    <PageHeader :title="$t('settings.title')" :subtitle="$t('settings.subtitle')">
      <template #actions>
        <Button :disabled="saving || !form" @click="handleSave">
          <span
            v-if="saving"
            class="h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground/30 border-t-primary-foreground"
            aria-hidden="true"
          />
          {{ $t('settings.save') }}
        </Button>
      </template>
    </PageHeader>

    <!-- Feedback alerts — always visible above tab layout -->
    <div v-if="error || successMessage" class="shrink-0 border-b border-border px-6 py-3">
      <Alert v-if="error" variant="destructive">
        <AlertDescription class="flex items-center justify-between">
          <span>{{ error }}</span>
          <button
            type="button"
            class="ml-2 opacity-70 transition-opacity hover:opacity-100"
            :aria-label="$t('aria.closeAlert')"
            @click="clearMessages()"
          >
            <AppIcon name="close" class="h-4 w-4" />
          </button>
        </AlertDescription>
      </Alert>
      <Alert v-if="successMessage" variant="success" :class="error ? 'mt-2' : ''">
        <AlertDescription class="flex items-center justify-between">
          <span>{{ $t('settings.saveSuccess') }}</span>
          <button
            type="button"
            class="ml-2 opacity-70 transition-opacity hover:opacity-100"
            :aria-label="$t('aria.closeAlert')"
            @click="clearMessages()"
          >
            <AppIcon name="close" class="h-4 w-4" />
          </button>
        </AlertDescription>
      </Alert>
    </div>

    <!-- Settings layout: sidebar nav + content -->
    <div class="flex min-h-0 flex-1 flex-col md:flex-row">

      <!-- Tab navigation — horizontal on mobile, vertical sidebar on desktop -->
      <nav
        role="tablist"
        :aria-label="$t('settings.title')"
        class="flex shrink-0 gap-0.5 overflow-x-auto border-b border-border px-3 py-2
               md:w-52 md:flex-col md:overflow-x-visible md:overflow-y-auto md:border-b-0 md:border-r md:px-3 md:py-4"
      >
        <button
          v-for="tab in tabs"
          :key="tab.id"
          role="tab"
          type="button"
          :aria-selected="activeTab === tab.id"
          :class="[
            'flex items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-sm transition-colors',
            'md:w-full',
            activeTab === tab.id
              ? 'bg-accent font-medium text-accent-foreground'
              : 'text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground',
          ]"
          @click="activeTab = tab.id"
        >
          <AppIcon :name="tab.icon" size="sm" />
          <span>{{ tab.label }}</span>
        </button>
      </nav>

      <!-- Content area -->
      <div class="flex-1 overflow-y-auto" role="tabpanel">
        <div class="mx-auto max-w-xl px-6 py-6 md:px-8 md:py-8">

          <!-- Loading skeletons -->
          <div v-if="loading" class="flex flex-col gap-6">
            <div>
              <Skeleton class="mb-2 h-5 w-28" />
              <Skeleton class="h-4 w-72" />
            </div>
            <div>
              <Skeleton class="mb-1.5 h-4 w-24" />
              <Skeleton class="h-10 w-44" />
              <Skeleton class="mt-1.5 h-3 w-56" />
            </div>
            <div>
              <Skeleton class="mb-1.5 h-4 w-20" />
              <Skeleton class="h-10 w-56" />
              <Skeleton class="mt-1.5 h-3 w-48" />
            </div>
          </div>

          <!-- Tab content -->
          <template v-else-if="form">

            <!-- ═══ General ═══ -->
            <div v-if="activeTab === 'general'">
              <div class="mb-8">
                <h2 class="text-lg font-semibold tracking-tight text-foreground">
                  {{ $t('settings.tabs.general') }}
                </h2>
                <p class="mt-1 text-sm text-muted-foreground">
                  {{ $t('settings.tabs.generalDescription') }}
                </p>
              </div>

              <div class="flex flex-col gap-6">
                <!-- Session timeout -->
                <div class="flex flex-col gap-1.5">
                  <Label for="session-timeout">{{ $t('settings.sessionTimeout') }}</Label>
                  <div class="flex items-center gap-2">
                    <Input
                      id="session-timeout"
                      v-model.number="form.sessionTimeoutMinutes"
                      type="number"
                      min="1"
                      max="1440"
                      class="w-28"
                    />
                    <span class="text-sm text-muted-foreground">{{ $t('settings.minutes') }}</span>
                  </div>
                  <p class="text-xs text-muted-foreground">{{ $t('settings.sessionTimeoutHint') }}</p>
                </div>

                <!-- Language -->
                <div class="flex flex-col gap-1.5">
                  <Label for="language-select">{{ $t('settings.language') }}</Label>
                  <Select id="language-select" v-model="form.language" class="w-56">
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
                  </Select>
                  <p class="text-xs text-muted-foreground">{{ $t('settings.languageHint') }}</p>
                </div>
              </div>
            </div>

            <!-- ═══ Agent ═══ -->
            <div v-else-if="activeTab === 'agent'">
              <div class="mb-8">
                <h2 class="text-lg font-semibold tracking-tight text-foreground">
                  {{ $t('settings.tabs.agent') }}
                </h2>
                <p class="mt-1 text-sm text-muted-foreground">
                  {{ $t('settings.tabs.agentDescription') }}
                </p>
              </div>

              <div class="flex flex-col gap-6">
                <!-- Heartbeat interval -->
                <div class="flex flex-col gap-1.5">
                  <Label for="heartbeat-interval">{{ $t('settings.heartbeatInterval') }}</Label>
                  <div class="flex items-center gap-2">
                    <Input
                      id="heartbeat-interval"
                      v-model.number="form.heartbeatIntervalMinutes"
                      type="number"
                      min="1"
                      max="60"
                      class="w-24"
                    />
                    <span class="text-sm text-muted-foreground">{{ $t('settings.minutes') }}</span>
                  </div>
                  <p class="text-xs text-muted-foreground">{{ $t('settings.heartbeatHint') }}</p>
                </div>
              </div>
            </div>

            <!-- ═══ Memory ═══ -->
            <div v-else-if="activeTab === 'memory'">
              <div class="mb-8">
                <h2 class="text-lg font-semibold tracking-tight text-foreground">
                  {{ $t('settings.tabs.memory') }}
                </h2>
                <p class="mt-1 text-sm text-muted-foreground">
                  {{ $t('settings.tabs.memoryDescription') }}
                </p>
              </div>

              <div class="flex flex-col gap-6">
                <!-- Enable toggle -->
                <div class="flex items-center justify-between rounded-lg border border-border px-4 py-3">
                  <div class="flex flex-col gap-0.5 pr-4">
                    <Label for="consolidation-enabled" class="cursor-pointer">
                      {{ $t('settings.consolidationEnabled') }}
                    </Label>
                    <p class="text-xs text-muted-foreground">
                      {{ $t('settings.consolidationEnabledHint') }}
                    </p>
                  </div>
                  <Switch
                    id="consolidation-enabled"
                    v-model="form.memoryConsolidation.enabled"
                  />
                </div>

                <!-- Configuration — progressive disclosure -->
                <template v-if="form.memoryConsolidation.enabled">
                  <div class="grid grid-cols-1 gap-6 sm:grid-cols-2">
                    <div class="flex flex-col gap-1.5">
                      <Label for="consolidation-hour">{{ $t('settings.consolidationRunAtHour') }}</Label>
                      <div class="flex items-center gap-2">
                        <Input
                          id="consolidation-hour"
                          v-model.number="form.memoryConsolidation.runAtHour"
                          type="number"
                          min="0"
                          max="23"
                          class="w-20"
                        />
                        <span class="text-sm text-muted-foreground">{{ $t('settings.oClock') }}</span>
                      </div>
                      <p class="text-xs text-muted-foreground">{{ $t('settings.consolidationRunAtHourHint') }}</p>
                    </div>

                    <div class="flex flex-col gap-1.5">
                      <Label for="consolidation-days">{{ $t('settings.consolidationLookbackDays') }}</Label>
                      <div class="flex items-center gap-2">
                        <Input
                          id="consolidation-days"
                          v-model.number="form.memoryConsolidation.lookbackDays"
                          type="number"
                          min="1"
                          max="30"
                          class="w-20"
                        />
                        <span class="text-sm text-muted-foreground">{{ $t('settings.days') }}</span>
                      </div>
                      <p class="text-xs text-muted-foreground">{{ $t('settings.consolidationLookbackDaysHint') }}</p>
                    </div>
                  </div>

                  <div class="flex flex-col gap-1.5">
                    <Label for="consolidation-provider">{{ $t('settings.consolidationProvider') }}</Label>
                    <Select id="consolidation-provider" v-model="form.memoryConsolidation.providerId" class="sm:w-72">
                      <option value="">{{ $t('settings.consolidationProviderDefault') }}</option>
                      <option v-for="p in providers" :key="p.id" :value="p.id">
                        {{ p.name }} ({{ p.defaultModel }})
                      </option>
                    </Select>
                    <p class="text-xs text-muted-foreground">{{ $t('settings.consolidationProviderHint') }}</p>
                  </div>

                  <!-- Manual run + status -->
                  <div class="flex flex-col gap-3 rounded-lg bg-muted/50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                    <div v-if="consolidationStatus" class="text-xs text-muted-foreground">
                      <span class="font-medium">{{ $t('settings.consolidationLastRun') }}:</span>
                      {{ consolidationStatus.lastRun ? new Date(consolidationStatus.lastRun).toLocaleString() : $t('settings.consolidationNeverRun') }}
                      <template v-if="consolidationStatus.lastResult">
                        · <span :class="consolidationStatus.lastResult.updated ? 'text-green-600 dark:text-green-400' : ''">
                          {{ consolidationStatus.lastResult.updated ? $t('settings.consolidationResultUpdated') : $t('settings.consolidationResultNoChange') }}
                        </span>
                      </template>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      class="shrink-0"
                      :disabled="consolidationRunning"
                      @click="handleRunConsolidation"
                    >
                      <span
                        v-if="consolidationRunning"
                        class="h-3.5 w-3.5 animate-spin rounded-full border-2 border-foreground/30 border-t-foreground"
                        aria-hidden="true"
                      />
                      {{ consolidationRunning ? $t('settings.consolidationRunning') : $t('settings.consolidationRunNow') }}
                    </Button>
                  </div>
                </template>
              </div>
            </div>

            <!-- ═══ Telegram ═══ -->
            <div v-else-if="activeTab === 'telegram'">
              <div class="mb-8">
                <h2 class="text-lg font-semibold tracking-tight text-foreground">
                  {{ $t('settings.tabs.telegram') }}
                </h2>
                <p class="mt-1 text-sm text-muted-foreground">
                  {{ $t('settings.tabs.telegramDescription') }}
                </p>
              </div>

              <div class="flex flex-col gap-6">
                <!-- Bot token -->
                <div class="flex flex-col gap-1.5">
                  <Label for="telegram-token">{{ $t('settings.telegramBotToken') }}</Label>
                  <Input
                    id="telegram-token"
                    v-model="form.telegramBotToken"
                    type="password"
                    autocomplete="off"
                    :placeholder="$t('settings.telegramBotTokenPlaceholder')"
                    class="sm:w-96"
                  />
                  <p class="text-xs text-muted-foreground">{{ $t('settings.telegramBotTokenHint') }}</p>
                </div>

                <!-- Batching delay -->
                <div class="flex flex-col gap-1.5">
                  <Label for="batching-delay">{{ $t('settings.batchingDelay') }}</Label>
                  <div class="flex items-center gap-2">
                    <Input
                      id="batching-delay"
                      v-model.number="form.batchingDelayMs"
                      type="number"
                      min="0"
                      max="10000"
                      step="100"
                      class="w-28"
                    />
                    <span class="text-sm text-muted-foreground">ms</span>
                  </div>
                  <p class="text-xs text-muted-foreground">{{ $t('settings.batchingDelayHint') }}</p>
                </div>
              </div>
            </div>

          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { MemoryConsolidationSettings } from '~/composables/useSettings'

/* ── Auth ── */
const { user } = useAuth()
const isAdmin = computed(() => user.value?.role === 'admin')

/* ── Tab routing — persisted in URL query for deep-linking ── */
const route = useRoute()
const router = useRouter()
const { t } = useI18n()

const VALID_TABS = ['general', 'agent', 'memory', 'telegram'] as const
type TabId = (typeof VALID_TABS)[number]

const activeTab = computed<TabId>({
  get() {
    const raw = route.query.tab as string
    return VALID_TABS.includes(raw as TabId) ? (raw as TabId) : 'general'
  },
  set(value: TabId) {
    router.replace({ query: { tab: value } })
  },
})

const tabs = computed(() => [
  { id: 'general' as TabId, icon: 'settings', label: t('settings.tabs.general') },
  { id: 'agent' as TabId, icon: 'bot', label: t('settings.tabs.agent') },
  { id: 'memory' as TabId, icon: 'brain', label: t('settings.tabs.memory') },
  { id: 'telegram' as TabId, icon: 'send', label: t('settings.tabs.telegram') },
])

/* ── Settings state ── */
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

/* ── Providers (consolidation dropdown) ── */
const { providers, fetchProviders } = useProviders()

/* ── Consolidation runtime ── */
const { apiFetch } = useApi()

interface ConsolidationStatus {
  lastRun: string | null
  lastResult: { updated: boolean; reason?: string } | null
}

const consolidationRunning = ref(false)
const consolidationStatus = ref<ConsolidationStatus | null>(null)

async function fetchConsolidationStatus() {
  try {
    consolidationStatus.value = await apiFetch<ConsolidationStatus>(
      '/api/memory/consolidation/status',
    )
  } catch {
    // Status display is optional — fail silently
  }
}

async function handleRunConsolidation() {
  consolidationRunning.value = true
  try {
    const result = await apiFetch<{ updated: boolean; reason?: string }>(
      '/api/memory/consolidation/run',
      { method: 'POST' },
    )
    consolidationStatus.value = {
      lastRun: new Date().toISOString(),
      lastResult: result,
    }
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    consolidationRunning.value = false
  }
}

/* ── Form state ── */
interface SettingsForm {
  sessionTimeoutMinutes: number
  language: string
  heartbeatIntervalMinutes: number
  batchingDelayMs: number
  telegramBotToken: string
  memoryConsolidation: MemoryConsolidationSettings
}

const form = ref<SettingsForm | null>(null)

function hydrateForm() {
  if (!settings.value) return
  const s = settings.value
  form.value = {
    sessionTimeoutMinutes: s.sessionTimeoutMinutes,
    language: s.language,
    heartbeatIntervalMinutes: s.heartbeatIntervalMinutes,
    batchingDelayMs: s.batchingDelayMs,
    telegramBotToken: s.telegramBotToken,
    memoryConsolidation: { ...s.memoryConsolidation },
  }
}

watch(settings, hydrateForm)

/* ── Save ── */
async function handleSave() {
  if (!form.value) return
  const success = await updateSettings(form.value)
  if (!success) return

  hydrateForm()
  setTimeout(() => {
    successMessage.value = null
  }, 3000)
}

/* ── Init ── */
onMounted(async () => {
  if (!isAdmin.value) return
  await Promise.all([
    fetchSettings(),
    fetchProviders(),
    fetchConsolidationStatus(),
  ])
  hydrateForm()
})
</script>
