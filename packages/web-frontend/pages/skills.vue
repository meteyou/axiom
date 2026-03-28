<template>
  <!-- Admin gate -->
  <div v-if="!isAdmin" class="flex h-full flex-col items-center justify-center gap-3 p-10 text-center text-muted-foreground">
    <AppIcon name="lock" size="xl" class="h-10 w-10" />
    <h1 class="text-xl font-semibold text-foreground">{{ $t('admin.title') }}</h1>
    <p class="text-sm">{{ $t('admin.description') }}</p>
  </div>

  <!-- Page body -->
  <div v-else class="flex h-full flex-col overflow-hidden">
    <PageHeader :title="$t('skills.title')" :subtitle="$t('skills.subtitle')">
      <template v-if="activeTab === 'installed'" #actions>
        <Button @click="showInstallDialog = true">
          <AppIcon name="add" class="mr-1 h-4 w-4" />
          {{ $t('skills.addSkill') }}
        </Button>
      </template>
    </PageHeader>

    <div class="mx-auto flex w-full max-w-5xl flex-1 flex-col overflow-hidden p-6">
      <!-- Error banner -->
      <Alert v-if="error" variant="destructive" class="mb-3 shrink-0">
        <AlertDescription class="flex items-center justify-between">
          <span>{{ error }}</span>
          <button type="button" class="ml-2 opacity-70 hover:opacity-100 transition-opacity" :aria-label="$t('aria.closeAlert')" @click="clearError()">
            <AppIcon name="close" class="h-4 w-4" />
          </button>
        </AlertDescription>
      </Alert>

      <!-- Success banner -->
      <Alert v-if="successMessage" variant="success" class="mb-3 shrink-0">
        <AlertDescription class="flex items-center justify-between">
          <span>{{ successMessage }}</span>
          <button type="button" class="ml-2 opacity-70 hover:opacity-100 transition-opacity" :aria-label="$t('aria.closeAlert')" @click="successMessage = null">
            <AppIcon name="close" class="h-4 w-4" />
          </button>
        </AlertDescription>
      </Alert>

      <!-- Tabs -->
      <Tabs v-model="activeTab" class="flex flex-1 flex-col overflow-hidden min-h-0">
        <div class="mb-4 flex shrink-0 flex-wrap items-center gap-3">
          <TabsList class="self-start">
            <TabsTrigger value="installed" @click="switchTab('installed')">{{ $t('skills.installedTab') }}</TabsTrigger>
            <TabsTrigger value="builtin" @click="switchTab('builtin')">{{ $t('skills.builtinTab') }}</TabsTrigger>
          </TabsList>
        </div>

        <!-- Installed Skills tab -->
        <TabsContent value="installed" class="flex flex-1 flex-col overflow-hidden min-h-0 mt-0">
          <div v-if="loading" class="flex flex-1 items-center justify-center py-20 text-sm text-muted-foreground">
            {{ $t('skills.loading') }}
          </div>

          <!-- Empty state -->
          <div v-else-if="skills.length === 0" class="flex flex-1 flex-col items-center justify-center gap-4 py-20 text-center text-muted-foreground">
            <AppIcon name="puzzle" size="xl" class="h-12 w-12 opacity-40" />
            <div>
              <p class="text-sm font-medium text-foreground">{{ $t('skills.emptyTitle') }}</p>
              <p class="mt-1 text-sm">{{ $t('skills.emptyDescription') }}</p>
            </div>
            <Button @click="showInstallDialog = true">
              <AppIcon name="add" class="mr-1 h-4 w-4" />
              {{ $t('skills.addFirstSkill') }}
            </Button>
          </div>

          <!-- Skills list -->
          <div v-else class="flex-1 space-y-3 overflow-y-auto min-h-0">
            <Card v-for="skill in skills" :key="skill.id" class="transition-colors">
              <div class="flex items-center gap-4 p-4">
                <!-- Emoji -->
                <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted text-lg">
                  {{ skill.emoji || '🧩' }}
                </div>

                <!-- Info -->
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-2">
                    <span class="font-semibold text-foreground truncate">{{ skill.id }}</span>
                  </div>
                  <p v-if="skill.description" class="mt-0.5 text-sm text-muted-foreground line-clamp-1">
                    {{ skill.description }}
                  </p>
                </div>

                <!-- Actions -->
                <div class="flex shrink-0 items-center gap-2">
                  <!-- Settings (only if envKeys) -->
                  <Tooltip v-if="skill.envKeys && skill.envKeys.length > 0">
                    <TooltipTrigger>
                      <Button variant="ghost" size="icon-sm" :aria-label="$t('skills.settings')" @click.stop="openSettings(skill)">
                        <AppIcon name="settings" class="h-4 w-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{{ $t('skills.settings') }}</TooltipContent>
                  </Tooltip>

                  <!-- Delete -->
                  <Tooltip>
                    <TooltipTrigger>
                      <Button variant="ghost" size="icon-sm" :aria-label="$t('skills.delete')" @click.stop="openDeleteConfirm(skill)">
                        <AppIcon name="trash" class="h-4 w-4 text-muted-foreground hover:text-destructive transition-colors" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{{ $t('skills.delete') }}</TooltipContent>
                  </Tooltip>

                  <!-- Toggle -->
                  <Switch
                    :model-value="skill.enabled"
                    :aria-label="$t('skills.toggleEnabled')"
                    @change="handleToggleSkill(skill)"
                  />
                </div>
              </div>
            </Card>
          </div>
        </TabsContent>

        <!-- Built-in Tools tab -->
        <TabsContent value="builtin" class="flex flex-1 flex-col overflow-hidden min-h-0 mt-0">
          <div v-if="builtinLoading" class="flex flex-1 items-center justify-center py-20 text-sm text-muted-foreground">
            {{ $t('skills.loading') }}
          </div>

          <div v-else class="flex-1 space-y-4 overflow-y-auto min-h-0">
            <!-- web_fetch card -->
            <Card>
              <CardHeader class="py-4">
                <div class="flex items-center justify-between">
                  <div class="flex items-center gap-3">
                    <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                      <AppIcon name="file" class="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div>
                      <CardTitle class="text-base">{{ $t('skills.webFetchTitle') }}</CardTitle>
                      <CardDescription class="mt-0.5">{{ $t('skills.webFetchDescription') }}</CardDescription>
                    </div>
                  </div>
                  <Switch
                    :model-value="localWebFetch.enabled"
                    :aria-label="$t('skills.toggleEnabled')"
                    @change="handleToggleWebFetch"
                  />
                </div>
              </CardHeader>
            </Card>

            <!-- web_search card -->
            <Card>
              <CardHeader class="py-4">
                <div class="flex items-center justify-between">
                  <div class="flex items-center gap-3">
                    <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                      <AppIcon name="globe" class="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div>
                      <CardTitle class="text-base">{{ $t('skills.webSearchTitle') }}</CardTitle>
                      <CardDescription class="mt-0.5">{{ $t('skills.webSearchDescription') }}</CardDescription>
                    </div>
                  </div>
                  <Switch
                    :model-value="localWebSearch.enabled"
                    :aria-label="$t('skills.toggleEnabled')"
                    @change="localWebSearch.enabled = !localWebSearch.enabled"
                  />
                </div>
              </CardHeader>
              <CardContent v-if="localWebSearch.enabled" class="space-y-4 pt-0">
                <!-- Provider select -->
                <div class="space-y-2">
                  <Label :for="'web-search-provider'">{{ $t('skills.webSearchProvider') }}</Label>
                  <Select
                    id="web-search-provider"
                    :model-value="localWebSearch.provider"
                    @update:model-value="localWebSearch.provider = $event as 'duckduckgo' | 'brave' | 'searxng'"
                  >
                    <option value="duckduckgo">DuckDuckGo</option>
                    <option value="brave">Brave Search</option>
                    <option value="searxng">SearXNG</option>
                  </Select>
                </div>

                <!-- Brave API Key (conditional) -->
                <div v-if="localWebSearch.provider === 'brave'" class="space-y-2">
                  <Label :for="'brave-api-key'">{{ $t('skills.braveApiKey') }}</Label>
                  <Input
                    id="brave-api-key"
                    v-model="localBraveApiKey"
                    type="password"
                    :placeholder="$t('skills.braveApiKeyPlaceholder')"
                    autocomplete="off"
                  />
                  <p class="text-xs text-muted-foreground">{{ $t('skills.braveApiKeyHint') }}</p>
                </div>

                <!-- SearXNG URL (conditional) -->
                <div v-if="localWebSearch.provider === 'searxng'" class="space-y-2">
                  <Label :for="'searxng-url'">{{ $t('skills.searxngUrl') }}</Label>
                  <Input
                    id="searxng-url"
                    v-model="localSearxngUrl"
                    type="text"
                    :placeholder="$t('skills.searxngUrlPlaceholder')"
                    autocomplete="off"
                  />
                  <p class="text-xs text-muted-foreground">{{ $t('skills.searxngUrlHint') }}</p>
                </div>

                <div class="flex justify-end">
                <Button size="sm" :disabled="savingBuiltin" @click="handleSaveWebSearch">
                  <span
                    v-if="savingBuiltin"
                    class="mr-1 h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground/30 border-t-primary-foreground"
                    aria-hidden="true"
                  />
                  {{ $t('common.save') }}
                </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  </div>

  <!-- Install Skill dialog -->
  <Dialog :open="showInstallDialog" @update:open="(v: boolean) => { if (!v) closeInstallDialog() }">
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{{ $t('skills.installTitle') }}</DialogTitle>
        <DialogDescription>{{ $t('skills.installDescription') }}</DialogDescription>
      </DialogHeader>

      <div class="space-y-4">
        <div class="space-y-2">
          <Label for="skill-source">{{ $t('skills.installSource') }}</Label>
          <Input
            id="skill-source"
            v-model="installSource"
            type="text"
            :placeholder="$t('skills.installPlaceholder')"
            :disabled="installing"
            autocomplete="off"
            @keydown.enter="handleInstall"
          />
          <div class="text-xs text-muted-foreground space-y-1">
            <p>{{ $t('skills.installExamples') }}</p>
            <code class="block rounded bg-muted px-2 py-1 text-[11px]">zats/perplexity</code>
            <code class="block rounded bg-muted px-2 py-1 text-[11px]">https://github.com/anthropics/skills/tree/main/skills/pdf</code>
          </div>
        </div>

        <!-- Install error -->
        <Alert v-if="installError" variant="destructive">
          <AlertDescription>{{ installError }}</AlertDescription>
        </Alert>
      </div>

      <DialogFooter>
        <Button variant="outline" :disabled="installing" @click="closeInstallDialog">
          {{ $t('common.cancel') }}
        </Button>
        <Button :disabled="!installSource.trim() || installing" @click="handleInstall">
          <span
            v-if="installing"
            class="mr-1 h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground/30 border-t-primary-foreground"
            aria-hidden="true"
          />
          {{ installing ? $t('skills.installing') : $t('skills.install') }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <!-- Skill Settings dialog -->
  <Dialog :open="!!settingsSkill" @update:open="(v: boolean) => { if (!v) closeSettings() }">
    <DialogContent>
      <DialogHeader>
        <DialogTitle>
          <span v-if="settingsSkill?.emoji" class="mr-2">{{ settingsSkill.emoji }}</span>
          {{ settingsSkill?.id }}
        </DialogTitle>
        <DialogDescription>{{ $t('skills.settingsDescription') }}</DialogDescription>
      </DialogHeader>

      <div class="space-y-4">
        <div v-for="key in settingsSkill?.envKeys" :key="key" class="space-y-2">
          <Label :for="`env-${key}`">{{ key }}</Label>
          <Input
            :id="`env-${key}`"
            :model-value="envValuesForm[key] || ''"
            type="password"
            :placeholder="$t('skills.envValuePlaceholder')"
            autocomplete="off"
            @update:model-value="envValuesForm[key] = $event"
          />
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" :disabled="savingSettings" @click="closeSettings">
          {{ $t('common.cancel') }}
        </Button>
        <Button :disabled="savingSettings" @click="handleSaveSettings">
          <span
            v-if="savingSettings"
            class="mr-1 h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground/30 border-t-primary-foreground"
            aria-hidden="true"
          />
          {{ $t('common.save') }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <!-- Delete confirmation dialog -->
  <ConfirmDialog
    :open="!!deleteTarget"
    :title="$t('skills.delete')"
    :description="$t('skills.deleteConfirm', { name: deleteTarget?.id ?? '' })"
    :confirm-label="$t('skills.deleteConfirmButton')"
    :cancel-label="$t('common.cancel')"
    :loading="deleting"
    destructive
    @confirm="handleDelete"
    @cancel="deleteTarget = null"
  />
</template>

<script setup lang="ts">
import type { Skill } from '~/composables/useSkills'

const { user } = useAuth()
const isAdmin = computed(() => user.value?.role === 'admin')

const {
  skills,
  builtinTools,
  braveSearchApiKey,
  searxngUrl,
  loading,
  error,
  installing,
  fetchSkills,
  fetchBuiltinTools,
  installSkill,
  updateSkill,
  deleteSkill,
  updateBuiltinTools,
  clearError,
} = useSkills()

const activeTab = ref<'installed' | 'builtin'>('installed')
const successMessage = ref<string | null>(null)
const builtinLoading = ref(false)

// Install dialog
const showInstallDialog = ref(false)
const installSource = ref('')
const installError = ref<string | null>(null)

// Settings dialog
const settingsSkill = ref<Skill | null>(null)
const envValuesForm = ref<Record<string, string>>({})
const savingSettings = ref(false)

// Delete dialog
const deleteTarget = ref<Skill | null>(null)
const deleting = ref(false)

// Built-in tools local state
const localWebSearch = reactive({
  enabled: true,
  provider: 'duckduckgo' as 'duckduckgo' | 'brave' | 'searxng',
})
const localWebFetch = reactive({
  enabled: true,
})
const localBraveApiKey = ref('')
const localSearxngUrl = ref('')
const savingBuiltin = ref(false)

function syncBuiltinLocal() {
  localWebSearch.enabled = builtinTools.value.webSearch.enabled
  localWebSearch.provider = builtinTools.value.webSearch.provider
  localWebFetch.enabled = builtinTools.value.webFetch.enabled
  localBraveApiKey.value = braveSearchApiKey.value
  localSearxngUrl.value = searxngUrl.value
}

async function switchTab(tab: 'installed' | 'builtin') {
  clearError()
  successMessage.value = null
  activeTab.value = tab

  if (tab === 'builtin') {
    builtinLoading.value = true
    await fetchBuiltinTools()
    syncBuiltinLocal()
    builtinLoading.value = false
  }
}

// Install skill
function closeInstallDialog() {
  showInstallDialog.value = false
  installSource.value = ''
  installError.value = null
}

async function handleInstall() {
  if (!installSource.value.trim()) return
  installError.value = null

  const result = await installSkill(installSource.value.trim())
  if (result) {
    closeInstallDialog()
    successMessage.value = t('skills.installSuccess')
    autoHideSuccess()
  } else {
    installError.value = error.value
    clearError()
  }
}

// Toggle skill enabled/disabled
async function handleToggleSkill(skill: Skill) {
  const newEnabled = !skill.enabled
  // Optimistic update
  const idx = skills.value.findIndex(s => s.id === skill.id)
  if (idx >= 0) skills.value[idx] = { ...skills.value[idx], enabled: newEnabled }

  const result = await updateSkill(skill.id, { enabled: newEnabled })
  if (!result && idx >= 0) {
    // Revert on failure
    skills.value[idx] = { ...skills.value[idx], enabled: !newEnabled }
  }
}

// Settings dialog
function openSettings(skill: Skill) {
  settingsSkill.value = skill
  envValuesForm.value = {}
  // Pre-populate with empty strings for each envKey
  for (const key of skill.envKeys ?? []) {
    envValuesForm.value[key] = ''
  }
}

function closeSettings() {
  settingsSkill.value = null
  envValuesForm.value = {}
}

async function handleSaveSettings() {
  if (!settingsSkill.value) return
  savingSettings.value = true

  // Only send non-empty values
  const envValues: Record<string, string> = {}
  for (const [key, value] of Object.entries(envValuesForm.value)) {
    if (value) envValues[key] = value
  }

  const result = await updateSkill(settingsSkill.value.id, { envValues })
  savingSettings.value = false

  if (result) {
    closeSettings()
    successMessage.value = t('skills.settingsSaved')
    autoHideSuccess()
  }
}

// Delete skill
function openDeleteConfirm(skill: Skill) {
  deleteTarget.value = skill
}

async function handleDelete() {
  if (!deleteTarget.value) return
  deleting.value = true

  const success = await deleteSkill(deleteTarget.value.id)
  deleting.value = false

  if (success) {
    deleteTarget.value = null
    successMessage.value = t('skills.deleteSuccess')
    autoHideSuccess()
  }
}

// Built-in tools: save web_search settings
async function handleSaveWebSearch() {
  savingBuiltin.value = true

  const input: {
    builtinTools: { webSearch: { enabled: boolean; provider: 'duckduckgo' | 'brave' | 'searxng' } }
    braveSearchApiKey?: string
    searxngUrl?: string
  } = {
    builtinTools: {
      webSearch: {
        enabled: localWebSearch.enabled,
        provider: localWebSearch.provider,
      },
    },
  }

  // Only send API key / URL if it changed (non-empty means user typed new value)
  if (localWebSearch.provider === 'brave' && localBraveApiKey.value !== braveSearchApiKey.value) {
    input.braveSearchApiKey = localBraveApiKey.value
  }
  if (localWebSearch.provider === 'searxng' && localSearxngUrl.value !== searxngUrl.value) {
    input.searxngUrl = localSearxngUrl.value
  }

  const success = await updateBuiltinTools(input)
  savingBuiltin.value = false

  if (success) {
    successMessage.value = t('skills.builtinSaved')
    autoHideSuccess()
  }
}

// Toggle web_fetch
async function handleToggleWebFetch() {
  const newEnabled = !localWebFetch.enabled
  localWebFetch.enabled = newEnabled

  const success = await updateBuiltinTools({
    builtinTools: {
      webFetch: { enabled: newEnabled },
    },
  })

  if (!success) {
    localWebFetch.enabled = !newEnabled
  }
}

const { t } = useI18n()

function autoHideSuccess() {
  setTimeout(() => {
    successMessage.value = null
  }, 3000)
}

onMounted(async () => {
  if (!isAdmin.value) return
  await fetchSkills()
})
</script>
