<template>
  <Dialog :open="open" @update:open="(v: boolean) => { if (!v && !oauthInProgress) emit('close') }">
    <DialogContent class="max-w-lg">
      <DialogHeader>
        <DialogTitle>{{ mode === 'edit' ? $t('providers.editProvider') : $t('providers.addProvider') }}</DialogTitle>
        <DialogDescription>{{ mode === 'edit' ? $t('providers.editProviderDescription') : $t('providers.addProviderDescription') }}</DialogDescription>
      </DialogHeader>

      <form class="flex flex-col gap-4" @submit.prevent="handleSubmit">
        <!-- Name -->
        <div class="flex flex-col gap-1.5">
          <Label for="provider-name">{{ $t('providers.name') }}</Label>
          <Input
            id="provider-name"
            v-model="form.name"
            type="text"
            :placeholder="$t('providers.namePlaceholder')"
            :disabled="oauthInProgress"
            required
          />
        </div>

        <!-- Type -->
        <div class="flex flex-col gap-1.5">
          <Label for="provider-type">{{ $t('providers.type') }}</Label>
          <Select
            v-model="form.providerType"
            :disabled="oauthInProgress"
            :required="true"
            @update:model-value="onTypeChange"
          >
            <SelectTrigger id="provider-type">
              <SelectValue :placeholder="$t('providers.selectType')" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel>{{ $t('providers.groupApiKey') }}</SelectLabel>
                <SelectItem v-for="(preset, key) in apiKeyPresets" :key="key" :value="String(key)">
                  {{ preset.label }}
                </SelectItem>
              </SelectGroup>
              <SelectSeparator />
              <SelectGroup>
                <SelectLabel>{{ $t('providers.groupSubscription') }}</SelectLabel>
                <SelectItem v-for="(preset, key) in oauthPresets" :key="key" :value="String(key)">
                  {{ preset.label }}
                </SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>

        <!-- Models (checkbox list for providers with pi-ai models) -->
        <div v-if="form.providerType && hasKnownModels" class="flex flex-col gap-1.5">
          <Label>{{ $t('providers.enabledModels') }}</Label>
          <div v-if="loadingModels" class="text-xs text-muted-foreground py-2">{{ $t('providers.loadingModels') }}</div>
          <div v-else-if="modelsError" class="flex flex-col gap-1">
            <span class="text-xs text-destructive">{{ $t('providers.modelsLoadError') }}</span>
            <button
              type="button"
              class="self-start text-xs text-destructive hover:underline"
              @click="loadModelsForType(form.providerType)"
            >
              {{ $t('providers.modelsRetry') }}
            </button>
          </div>
          <div v-else class="flex flex-col gap-0 rounded-md border border-border overflow-hidden max-h-52 overflow-y-auto">
            <label
              v-for="model in availableModels"
              :key="model.id"
              :class="[
                'flex items-center gap-3 px-3 py-2 text-sm cursor-pointer transition-colors hover:bg-accent/50',
                form.enabledModels.includes(model.id) ? 'bg-accent/30' : '',
              ]"
            >
              <input
                type="checkbox"
                :checked="form.enabledModels.includes(model.id)"
                class="h-4 w-4 rounded border-border text-primary focus:ring-primary"
                :disabled="oauthInProgress"
                @change="toggleModel(model.id)"
              >
              <span class="flex-1 truncate">{{ model.name }}</span>
            </label>
          </div>
          <p class="text-xs text-muted-foreground">{{ $t('providers.enabledModelsHint') }}</p>
        </div>

        <!-- Ollama: model list from Ollama API + pull -->
        <div v-else-if="form.providerType && isOllamaProvider" class="flex flex-col gap-2">
          <div class="flex items-center justify-between">
            <Label>{{ $t('providers.ollamaModels') }}</Label>
            <button
              type="button"
              class="text-xs text-primary hover:underline disabled:opacity-50"
              :disabled="ollamaLoading"
              @click="loadOllamaModels"
            >
              {{ ollamaLoading ? $t('providers.ollamaModelsLoading') : (ollamaModels.length > 0 ? $t('providers.ollamaModelsRefresh') : $t('providers.ollamaModelsRefresh')) }}
            </button>
          </div>

          <!-- Not loaded yet -->
          <div v-if="!ollamaLoaded && !ollamaLoading && !ollamaError" class="rounded-md border border-dashed border-border bg-muted/30 px-3 py-3 text-xs text-muted-foreground">
            {{ $t('providers.ollamaNoModelsHint') }}
          </div>

          <!-- Loading -->
          <div v-else-if="ollamaLoading" class="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-3 text-xs text-muted-foreground">
            <span class="h-3 w-3 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
            {{ $t('providers.ollamaModelsLoading') }}
          </div>

          <!-- Error -->
          <div v-else-if="ollamaError" class="flex flex-col gap-1">
            <div class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {{ $t('providers.ollamaModelsError') }}: {{ ollamaError }}
            </div>
            <button
              type="button"
              class="self-start text-xs text-destructive hover:underline"
              @click="loadOllamaModels"
            >
              {{ $t('providers.modelsRetry') }}
            </button>
          </div>

          <!-- Empty -->
          <div v-else-if="ollamaModels.length === 0" class="rounded-md border border-dashed border-border bg-muted/30 px-3 py-3 text-xs text-muted-foreground">
            {{ $t('providers.ollamaModelsEmpty') }}
          </div>

          <!-- Model list -->
          <div v-else class="flex flex-col gap-0 rounded-md border border-border overflow-hidden max-h-52 overflow-y-auto">
            <label
              v-for="model in ollamaModels"
              :key="model.name"
              :class="[
                'flex items-center gap-3 px-3 py-2 text-sm cursor-pointer transition-colors hover:bg-accent/50',
                form.enabledModels.includes(model.name) ? 'bg-accent/30' : '',
              ]"
            >
              <input
                type="checkbox"
                :checked="form.enabledModels.includes(model.name)"
                class="h-4 w-4 rounded border-border text-primary focus:ring-primary"
                @change="toggleOllamaModel(model.name)"
              >
              <div class="flex-1 min-w-0">
                <span class="font-mono text-xs truncate block">{{ model.name }}</span>
                <span class="text-[10px] text-muted-foreground">
                  {{ model.parameterSize }}
                  <template v-if="model.quantization"> · {{ model.quantization }}</template>
                  · {{ formatSize(model.size) }}
                </span>
              </div>

            </label>
          </div>
          <p v-if="ollamaModels.length > 0" class="text-xs text-muted-foreground">{{ $t('providers.enabledModelsHint') }}</p>

          <!-- Pull model -->
          <div class="flex flex-col gap-1.5 mt-1">
            <Label>{{ $t('providers.ollamaPullModel') }}</Label>
            <div class="flex gap-2">
              <Input
                v-model="ollamaPullName"
                type="text"
                :placeholder="$t('providers.ollamaPullPlaceholder')"
                :disabled="ollamaPulling"
                class="flex-1 font-mono text-xs"
                @keydown.enter.prevent="pullModel"
              />
              <Button
                type="button"
                variant="outline"
                :disabled="!ollamaPullName.trim() || ollamaPulling"
                class="shrink-0"
                @click="pullModel"
              >
                <span
                  v-if="ollamaPulling"
                  class="mr-1.5 h-3 w-3 animate-spin rounded-full border-2 border-primary/30 border-t-primary"
                />
                {{ ollamaPulling ? $t('providers.ollamaPulling') : 'Pull' }}
              </Button>
            </div>

            <!-- Pull progress -->
            <div v-if="ollamaPulling" class="flex flex-col gap-1.5">
              <div class="flex items-center justify-between text-xs text-muted-foreground">
                <span>{{ ollamaPullStatus || $t('providers.ollamaPulling') + '...' }}</span>
                <span v-if="ollamaPullProgress > 0" class="font-medium tabular-nums text-foreground">{{ ollamaPullProgress }}%</span>
              </div>
              <div class="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                <div
                  class="h-full rounded-full bg-primary transition-all duration-300"
                  :style="{ width: `${ollamaPullProgress}%` }"
                />
              </div>
            </div>

            <!-- Pull result -->
            <div v-if="ollamaPullResult" :class="[
              'rounded-md px-3 py-2 text-xs',
              ollamaPullResult.success
                ? 'border border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-400'
                : 'border border-destructive/30 bg-destructive/10 text-destructive',
            ]">
              {{ ollamaPullResult.message }}
            </div>
          </div>
        </div>

        <!-- Model (free text for other unknown providers) -->
        <div v-else-if="form.providerType && !isOAuthProvider" class="flex flex-col gap-1.5">
          <Label for="provider-model">{{ $t('providers.model') }}</Label>
          <Input
            id="provider-model"
            v-model="form.defaultModel"
            type="text"
            :placeholder="$t('providers.modelPlaceholderCustom')"
            required
          />
        </div>

        <!-- API Key (all non-OAuth providers; optional for providers that don't require it) -->
        <div v-if="form.providerType && !isOAuthProvider" class="flex flex-col gap-1.5">
          <Label for="provider-key">
            {{ $t('providers.apiKey') }}
            <span v-if="!selectedPreset?.requiresApiKey" class="text-xs font-normal text-muted-foreground">({{ $t('providers.optional') }})</span>
          </Label>
          <Input
            id="provider-key"
            v-model="form.apiKey"
            type="password"
            :placeholder="mode === 'edit' ? $t('providers.apiKeyHint') : $t('providers.apiKeyPlaceholder')"
          />
          <p v-if="mode === 'edit'" class="text-xs text-muted-foreground">{{ $t('providers.apiKeyHint') }}</p>
          <p v-if="!selectedPreset?.requiresApiKey && mode !== 'edit'" class="text-xs text-muted-foreground">{{ $t('providers.apiKeyOptionalHint') }}</p>
        </div>

        <!-- Base URL (only for providers with editable URLs) -->
        <div v-if="form.providerType && !isOAuthProvider && selectedPreset?.urlEditable" class="flex flex-col gap-1.5">
          <Label for="provider-url">{{ $t('providers.baseUrl') }}</Label>
          <Input
            id="provider-url"
            v-model="form.baseUrl"
            type="url"
            placeholder="https://..."
          />
          <p v-if="selectedPreset?.type === 'ollama-local'" class="text-xs text-muted-foreground">
            {{ $t('providers.ollamaUrlHint') }}
          </p>
        </div>

        <!-- Degraded Threshold -->
        <div v-if="form.providerType" class="flex flex-col gap-1.5">
          <Label for="provider-degraded-threshold">{{ $t('providers.degradedThreshold') }}</Label>
          <div class="flex items-center gap-2">
            <Input
              id="provider-degraded-threshold"
              v-model.number="form.degradedThresholdMs"
              type="number"
              min="1"
              step="1"
              :placeholder="$t('providers.degradedThresholdPlaceholder')"
              :disabled="oauthInProgress"
              class="flex-1"
            />
            <span class="text-xs text-muted-foreground">ms</span>
          </div>
          <p class="text-xs text-muted-foreground">{{ $t('providers.degradedThresholdHint') }}</p>
        </div>

        <!-- OAuth Login Section -->
        <div v-if="isOAuthProvider && (mode === 'create' || oauthInProgress)" class="flex flex-col gap-3">
          <!-- OAuth status messages -->
          <div v-if="oauthInProgress" class="rounded-md border border-border bg-muted/50 p-4">
            <div class="flex items-center gap-3">
              <span
                class="h-4 w-4 animate-spin rounded-full border-2 border-primary/30 border-t-primary"
                aria-hidden="true"
              />
              <div class="flex-1">
                <p class="text-sm font-medium">{{ $t('providers.oauthWaiting') }}</p>
                <p class="mt-1 text-xs text-muted-foreground">{{ $t('providers.oauthWaitingHint') }}</p>
              </div>
            </div>

            <!-- Manual code input fallback -->
            <div v-if="oauthUsesCallback" class="mt-3 flex flex-col gap-1.5">
              <Label for="oauth-code" class="text-xs">{{ $t('providers.oauthManualCode') }}</Label>
              <div class="flex gap-2">
                <Input
                  id="oauth-code"
                  v-model="manualCode"
                  type="text"
                  :placeholder="$t('providers.oauthManualCodePlaceholder')"
                  class="flex-1 text-xs"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  :disabled="!manualCode.trim()"
                  @click="submitManualCode"
                >
                  {{ $t('providers.oauthSubmitCode') }}
                </Button>
              </div>
            </div>
          </div>

          <div v-if="oauthError" class="rounded-md border border-destructive/50 bg-destructive/10 p-3">
            <p class="text-sm text-destructive">{{ oauthError }}</p>
          </div>
        </div>

        <DialogFooter class="!flex-row !justify-start items-center">
          <!-- Renew token button (left-aligned, only for OAuth edit mode) -->
          <Button
            v-if="isOAuthProvider && mode === 'edit'"
            type="button"
            variant="outline"
            :disabled="oauthInProgress"
            @click="startOAuthRenew"
          >
            <span
              v-if="oauthInProgress"
              class="mr-1.5 h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground/30 border-t-primary-foreground"
              aria-hidden="true"
            />
            {{ oauthInProgress ? $t('providers.oauthRenewing') : $t('providers.oauthRenewToken') }}
          </Button>
          <div class="flex-1" />
          <div class="flex items-center gap-2">
            <Button type="button" variant="outline" :disabled="oauthInProgress" @click="emit('close')">
              {{ $t('providers.cancel') }}
            </Button>
            <!-- Regular save for API key providers or edit mode -->
            <Button
              v-if="!isOAuthProvider || mode === 'edit'"
              type="submit"
            >
              {{ $t('providers.save') }}
            </Button>
            <!-- OAuth login button for create mode -->
            <Button
              v-else-if="mode === 'create'"
              type="button"
              :disabled="!canStartOAuth || oauthInProgress"
              @click="startOAuth"
            >
              <span
                v-if="oauthInProgress"
                class="mr-1.5 h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground/30 border-t-primary-foreground"
                aria-hidden="true"
              />
              {{ oauthInProgress ? $t('providers.oauthConnecting') : $t('providers.oauthLogin') }}
            </Button>
          </div>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import type { Provider, ProviderTypePreset, AvailableModel, OllamaModel, OllamaPullEvent } from '~/composables/useProviders'

export interface ProviderFormPayload {
  name: string
  providerType: string
  baseUrl: string
  apiKey: string
  defaultModel: string
  enabledModels: string[]
  degradedThresholdMs: number
}

const props = defineProps<{
  open: boolean
  mode: 'create' | 'edit'
  provider?: Provider | null
  presets: Record<string, ProviderTypePreset>
}>()

const emit = defineEmits<{
  close: []
  submit: [payload: ProviderFormPayload]
  oauthComplete: []
}>()

const { fetchModels, fetchOllamaModels, probeOllamaModels, pullOllamaModel, probeOllamaPull, startOAuthLogin, pollOAuthStatus, submitOAuthCode, fetchProviders } = useProviders()
const { t } = useI18n()

const form = reactive({
  name: '',
  providerType: '',
  baseUrl: '',
  apiKey: '',
  defaultModel: '',
  enabledModels: [] as string[],
  degradedThresholdMs: 5000,
})

const availableModels = ref<AvailableModel[]>([])
const loadingModels = ref(false)
const modelsError = ref<string | null>(null)
const oauthInProgress = ref(false)
const oauthError = ref<string | null>(null)
const oauthLoginId = ref<string | null>(null)
const oauthUsesCallback = ref(false)
const manualCode = ref('')

// Ollama state
const ollamaModels = ref<OllamaModel[]>([])
const ollamaLoading = ref(false)
const ollamaLoaded = ref(false)
const ollamaError = ref<string | null>(null)
const ollamaPullName = ref('')
const ollamaPulling = ref(false)
const ollamaPullStatus = ref('')
const ollamaPullProgress = ref(0)
const ollamaPullResult = ref<{ success: boolean; message: string } | null>(null)

const isOllamaProvider = computed(() => {
  return form.providerType === 'ollama-local' || form.providerType === 'ollama-cloud'
})

const selectedPreset = computed(() => {
  if (!form.providerType) return null
  return props.presets[form.providerType] ?? null
})

const hasKnownModels = computed(() => {
  return selectedPreset.value?.piAiProvider != null
})

const isOAuthProvider = computed(() => {
  return selectedPreset.value?.authMethod === 'oauth'
})

const canStartOAuth = computed(() => {
  return form.name.trim() && form.providerType && form.defaultModel
})

const apiKeyPresets = computed(() => {
  return Object.fromEntries(
    Object.entries(props.presets).filter(([, p]) => p.authMethod !== 'oauth')
  )
})

const oauthPresets = computed(() => {
  return Object.fromEntries(
    Object.entries(props.presets).filter(([, p]) => p.authMethod === 'oauth')
  )
})

// Sync form state when dialog opens or provider changes
watch(() => [props.open, props.provider] as const, ([isOpen, entry]) => {
  if (isOpen && props.mode === 'edit' && entry) {
    form.name = entry.name
    form.providerType = entry.providerType
    form.baseUrl = entry.baseUrl
    form.apiKey = ''
    form.defaultModel = entry.defaultModel
    form.enabledModels = entry.enabledModels?.length ? [...entry.enabledModels] : [entry.defaultModel]
    form.degradedThresholdMs = entry.degradedThresholdMs ?? 5000
    // Reset Ollama state
    resetOllamaState()
    if (entry.providerType === 'ollama-local' || entry.providerType === 'ollama-cloud') {
      loadOllamaModels()
    } else if (entry.providerType) {
      loadModelsForType(entry.providerType)
    }
  } else if (isOpen && props.mode === 'create') {
    form.name = ''
    form.providerType = ''
    form.baseUrl = ''
    form.apiKey = ''
    form.defaultModel = ''
    form.enabledModels = []
    form.degradedThresholdMs = 5000
    availableModels.value = []
    modelsError.value = null
    resetOllamaState()
    oauthInProgress.value = false
    oauthError.value = null
    oauthLoginId.value = null
    manualCode.value = ''
  }
}, { immediate: true })

function resetOllamaState() {
  ollamaModels.value = []
  ollamaLoading.value = false
  ollamaLoaded.value = false
  ollamaError.value = null
  ollamaPullName.value = ''
  ollamaPulling.value = false
  ollamaPullStatus.value = ''
  ollamaPullProgress.value = 0
  ollamaPullResult.value = null
}

async function loadOllamaModels() {
  // For create mode, we need the provider to exist first
  // Use a temporary fetch directly with the base URL
  if (props.mode === 'edit' && props.provider?.id) {
    ollamaLoading.value = true
    ollamaError.value = null
    try {
      const models = await fetchOllamaModels(props.provider.id)
      ollamaModels.value = models
      ollamaLoaded.value = true
      // Filter enabledModels to only include models that exist in Ollama
      const ollamaNames = new Set(models.map(m => m.name))
      form.enabledModels = form.enabledModels.filter(m => ollamaNames.has(m))
      if (form.defaultModel && !ollamaNames.has(form.defaultModel)) {
        form.defaultModel = form.enabledModels[0] ?? ''
      }
    } catch (err) {
      ollamaError.value = (err as Error).message
    } finally {
      ollamaLoading.value = false
    }
  } else if (props.mode === 'create') {
    // For create mode, probe Ollama via backend endpoint (avoids CORS / SSRF issues)
    ollamaLoading.value = true
    ollamaError.value = null
    try {
      const baseUrl = form.baseUrl || 'http://localhost:11434/v1'
      const models = await probeOllamaModels(baseUrl, form.providerType)
      ollamaModels.value = models
      ollamaLoaded.value = true
      // Filter enabledModels to only include models that exist in Ollama
      const ollamaNames = new Set(models.map(m => m.name))
      form.enabledModels = form.enabledModels.filter(m => ollamaNames.has(m))
      if (form.defaultModel && !ollamaNames.has(form.defaultModel)) {
        form.defaultModel = form.enabledModels[0] ?? ''
      }
    } catch (err) {
      ollamaError.value = (err as Error).message
    } finally {
      ollamaLoading.value = false
    }
  }
}

function toggleOllamaModel(modelName: string) {
  const idx = form.enabledModels.indexOf(modelName)
  if (idx >= 0) {
    if (form.enabledModels.length <= 1) return
    form.enabledModels.splice(idx, 1)
    if (form.defaultModel === modelName) {
      form.defaultModel = form.enabledModels[0] ?? ''
    }
  } else {
    form.enabledModels.push(modelName)
    if (!form.defaultModel) {
      form.defaultModel = modelName
    }
  }
}

async function pullModel() {
  if (!ollamaPullName.value.trim()) return
  ollamaPulling.value = true
  ollamaPullStatus.value = ''
  ollamaPullProgress.value = 0
  ollamaPullResult.value = null

  try {
    if (props.mode === 'edit' && props.provider?.id) {
      // Use backend SSE endpoint
      await pullOllamaModel(props.provider.id, ollamaPullName.value.trim(), (event) => {
        if (event.error) {
          ollamaPullResult.value = { success: false, message: event.error }
        } else if (event.status) {
          ollamaPullStatus.value = event.status
          if (event.total && event.total > 0) {
            ollamaPullProgress.value = Math.round(((event.completed ?? 0) / event.total) * 100)
          }
        }
      })
    } else {
      // Create mode: pull via backend probe endpoint
      const baseUrl = form.baseUrl || 'http://localhost:11434/v1'
      await probeOllamaPull(baseUrl, form.providerType, ollamaPullName.value.trim(), (event: OllamaPullEvent) => {
        if (event.error) {
          ollamaPullResult.value = { success: false, message: event.error }
        } else if (event.status) {
          ollamaPullStatus.value = event.status
          if (event.total && event.total > 0) {
            ollamaPullProgress.value = Math.round(((event.completed ?? 0) / event.total) * 100)
          }
        }
      })
    }

    if (!ollamaPullResult.value || ollamaPullResult.value.success !== false) {
      ollamaPullResult.value = { success: true, message: t('providers.ollamaPullSuccess') }
      ollamaPullName.value = ''
      // Refresh model list
      await loadOllamaModels()
    }
  } catch (err) {
    ollamaPullResult.value = { success: false, message: `${t('providers.ollamaPullError')}: ${(err as Error).message}` }
  } finally {
    ollamaPulling.value = false
    ollamaPullStatus.value = ''
    ollamaPullProgress.value = 0
  }
}

function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 1 ? 1 : 0)} ${units[i]}`
}

async function loadModelsForType(providerType: string) {
  const preset = props.presets[providerType]
  if (!preset?.piAiProvider) {
    availableModels.value = []
    modelsError.value = null
    return
  }

  loadingModels.value = true
  modelsError.value = null
  try {
    const models = await fetchModels(providerType)
    if (models.length === 0) {
      modelsError.value = 'no_models'
    } else {
      availableModels.value = models
    }
  } catch {
    modelsError.value = 'fetch_failed'
    availableModels.value = []
  } finally {
    loadingModels.value = false
  }
}

function toggleModel(modelId: string) {
  const idx = form.enabledModels.indexOf(modelId)
  if (idx >= 0) {
    // Don't allow unchecking the last enabled model
    if (form.enabledModels.length <= 1) return
    form.enabledModels.splice(idx, 1)
    // If we removed the default, reassign
    if (form.defaultModel === modelId) {
      form.defaultModel = form.enabledModels[0] ?? ''
    }
  } else {
    form.enabledModels.push(modelId)
    // If no default is set yet, set it
    if (!form.defaultModel) {
      form.defaultModel = modelId
    }
  }
}

function onTypeChange() {
  const preset = props.presets[form.providerType]
  if (preset && props.mode !== 'edit') {
    form.baseUrl = preset.baseUrl
    form.defaultModel = ''
    form.enabledModels = []
  }
  oauthError.value = null
  resetOllamaState()
  if (form.providerType === 'ollama-local' || form.providerType === 'ollama-cloud') {
    loadOllamaModels()
  } else {
    loadModelsForType(form.providerType)
  }
}

function handleSubmit() {
  // Ensure enabledModels always includes the default model
  const enabledModels = form.enabledModels.length > 0 ? [...form.enabledModels] : [form.defaultModel]
  if (!enabledModels.includes(form.defaultModel) && form.defaultModel) {
    enabledModels.unshift(form.defaultModel)
  }
  emit('submit', { ...form, enabledModels })
}

async function startOAuthRenew() {
  if (!props.provider?.id || oauthInProgress.value) return

  oauthInProgress.value = true
  oauthError.value = null
  manualCode.value = ''

  try {
    const response = await startOAuthLogin({
      providerType: form.providerType,
      name: form.name.trim(),
      defaultModel: form.defaultModel,
      providerId: props.provider.id,
    })

    oauthLoginId.value = response.loginId
    oauthUsesCallback.value = response.usesCallbackServer

    if (response.authUrl) {
      window.open(response.authUrl, '_blank')
    }

    pollForCompletion(response.loginId)
  } catch (err) {
    oauthError.value = (err as Error).message
    oauthInProgress.value = false
  }
}

async function startOAuth() {
  if (!canStartOAuth.value) return

  oauthInProgress.value = true
  oauthError.value = null
  manualCode.value = ''

  try {
    const response = await startOAuthLogin({
      providerType: form.providerType,
      name: form.name.trim(),
      defaultModel: form.defaultModel,
    })

    oauthLoginId.value = response.loginId
    oauthUsesCallback.value = response.usesCallbackServer

    // Open auth URL in new tab
    if (response.authUrl) {
      window.open(response.authUrl, '_blank')
    }

    // Start polling for completion
    pollForCompletion(response.loginId)
  } catch (err) {
    oauthError.value = (err as Error).message
    oauthInProgress.value = false
  }
}

async function pollForCompletion(loginId: string) {
  const maxAttempts = 120 // 2 minutes at 1s intervals
  for (let i = 0; i < maxAttempts; i++) {
    if (!oauthInProgress.value) return // cancelled

    await new Promise(resolve => setTimeout(resolve, 1000))

    try {
      const status = await pollOAuthStatus(loginId)

      if (status.status === 'completed') {
        oauthInProgress.value = false
        oauthLoginId.value = null
        await fetchProviders()
        emit('oauthComplete')
        emit('close')
        return
      }

      if (status.status === 'error') {
        oauthError.value = status.error ?? 'OAuth login failed'
        oauthInProgress.value = false
        oauthLoginId.value = null
        return
      }
    } catch (err) {
      oauthError.value = (err as Error).message
      oauthInProgress.value = false
      oauthLoginId.value = null
      return
    }
  }

  // Timeout
  oauthError.value = 'Login timed out. Please try again.'
  oauthInProgress.value = false
  oauthLoginId.value = null
}

async function submitManualCode() {
  if (!oauthLoginId.value || !manualCode.value.trim()) return

  try {
    await submitOAuthCode(oauthLoginId.value, manualCode.value.trim())
    manualCode.value = ''
  } catch (err) {
    oauthError.value = (err as Error).message
  }
}
</script>
