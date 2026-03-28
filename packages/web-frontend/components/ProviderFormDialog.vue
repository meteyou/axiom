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
            id="provider-type"
            v-model="form.providerType"
            :disabled="oauthInProgress"
            required
            @change="onTypeChange"
          >
            <option value="" disabled>{{ $t('providers.selectType') }}</option>
            <optgroup :label="$t('providers.groupApiKey')">
              <option v-for="(preset, key) in apiKeyPresets" :key="key" :value="key">
                {{ preset.label }}
              </option>
            </optgroup>
            <optgroup :label="$t('providers.groupSubscription')">
              <option v-for="(preset, key) in oauthPresets" :key="key" :value="key">
                {{ preset.label }}
              </option>
            </optgroup>
          </Select>
        </div>

        <!-- Model (select dropdown for providers with pi-ai models) -->
        <div v-if="form.providerType && hasKnownModels" class="flex flex-col gap-1.5">
          <Label for="provider-model">{{ $t('providers.model') }}</Label>
          <Select
            id="provider-model"
            v-model="form.defaultModel"
            :disabled="loadingModels || oauthInProgress"
            required
          >
            <option value="" disabled>
              {{ loadingModels ? $t('providers.loadingModels') : $t('providers.selectModel') }}
            </option>
            <option v-for="model in availableModels" :key="model.id" :value="model.id">
              {{ model.name }} ({{ model.id }})
            </option>
          </Select>
        </div>

        <!-- Model (free text for Ollama / unknown providers) -->
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

        <!-- API Key (only for API key providers that require it) -->
        <div v-if="form.providerType && !isOAuthProvider && selectedPreset?.requiresApiKey" class="flex flex-col gap-1.5">
          <Label for="provider-key">{{ $t('providers.apiKey') }}</Label>
          <Input
            id="provider-key"
            v-model="form.apiKey"
            type="password"
            :placeholder="mode === 'edit' ? $t('providers.apiKeyHint') : $t('providers.apiKeyPlaceholder')"
          />
          <p v-if="mode === 'edit'" class="text-xs text-muted-foreground">{{ $t('providers.apiKeyHint') }}</p>
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
        <div v-if="isOAuthProvider && mode === 'create'" class="flex flex-col gap-3">
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

        <DialogFooter>
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
            v-else
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
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import type { Provider, ProviderTypePreset, AvailableModel } from '~/composables/useProviders'

export interface ProviderFormPayload {
  name: string
  providerType: string
  baseUrl: string
  apiKey: string
  defaultModel: string
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

const { fetchModels, startOAuthLogin, pollOAuthStatus, submitOAuthCode, fetchProviders } = useProviders()

const form = reactive({
  name: '',
  providerType: '',
  baseUrl: '',
  apiKey: '',
  defaultModel: '',
  degradedThresholdMs: 5000,
})

const availableModels = ref<AvailableModel[]>([])
const loadingModels = ref(false)
const oauthInProgress = ref(false)
const oauthError = ref<string | null>(null)
const oauthLoginId = ref<string | null>(null)
const oauthUsesCallback = ref(false)
const manualCode = ref('')

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
    form.degradedThresholdMs = entry.degradedThresholdMs ?? 5000
    if (entry.providerType) {
      loadModelsForType(entry.providerType)
    }
  } else if (isOpen && props.mode === 'create') {
    form.name = ''
    form.providerType = ''
    form.baseUrl = ''
    form.apiKey = ''
    form.defaultModel = ''
    form.degradedThresholdMs = 5000
    availableModels.value = []
    oauthInProgress.value = false
    oauthError.value = null
    oauthLoginId.value = null
    manualCode.value = ''
  }
}, { immediate: true })

async function loadModelsForType(providerType: string) {
  const preset = props.presets[providerType]
  if (!preset?.piAiProvider) {
    availableModels.value = []
    return
  }

  loadingModels.value = true
  try {
    availableModels.value = await fetchModels(providerType)
  } finally {
    loadingModels.value = false
  }
}

function onTypeChange() {
  const preset = props.presets[form.providerType]
  if (preset && props.mode !== 'edit') {
    form.baseUrl = preset.baseUrl
    form.defaultModel = ''
  }
  oauthError.value = null
  loadModelsForType(form.providerType)
}

function handleSubmit() {
  emit('submit', { ...form })
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
