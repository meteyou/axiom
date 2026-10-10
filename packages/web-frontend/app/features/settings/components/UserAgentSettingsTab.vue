<template>
  <div>
    <div class="mb-8">
      <h2 class="text-lg font-semibold tracking-tight text-foreground">
        {{ $t('settings.tabs.agent') }}
      </h2>
      <p class="mt-1 text-sm text-muted-foreground">
        {{ $t('settings.userAgent.description') }}
      </p>
    </div>

    <Alert v-if="error" variant="destructive" class="mb-4">
      <AlertDescription class="flex items-center justify-between">
        <span>{{ error }}</span>
        <button type="button" class="ml-2 opacity-70 transition-opacity hover:opacity-100" :aria-label="$t('aria.closeAlert')" @click="error = null">
          <AppIcon name="close" class="h-4 w-4" />
        </button>
      </AlertDescription>
    </Alert>
    <Alert v-if="saved" variant="success" class="mb-4">
      <AlertDescription>{{ $t('settings.saveSuccess') }}</AlertDescription>
    </Alert>

    <div v-if="loading" class="flex flex-col gap-6">
      <Skeleton class="h-10 w-full" />
      <Skeleton class="h-10 w-full" />
      <Skeleton class="h-10 w-full" />
    </div>

    <div v-else-if="settings" class="flex flex-col gap-8">
      <div class="flex flex-col gap-2">
        <Label for="user-chat-model">{{ $t('settings.userAgent.model') }}</Label>
        <Select :model-value="modelValue" :disabled="saving" @update:model-value="(v) => handleModelChange(v as string)">
          <SelectTrigger id="user-chat-model">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem :value="DEFAULT_VALUE">{{ defaultLabel(defaultModelLabel) }}</SelectItem>
            <SelectItem v-for="opt in modelOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</SelectItem>
          </SelectContent>
        </Select>
        <p class="text-xs text-muted-foreground">{{ $t('settings.userAgent.modelHint') }}</p>
      </div>

      <div class="flex flex-col gap-2">
        <Label for="user-thinking-level">{{ $t('settings.thinkingLevel') }}</Label>
        <Select :model-value="settings.overrides.thinkingLevel ?? DEFAULT_VALUE" :disabled="saving" @update:model-value="(v) => handleThinkingChange(v as string)">
          <SelectTrigger id="user-thinking-level">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem :value="DEFAULT_VALUE">{{ defaultLabel($t(`settings.thinkingLevelOptions.${settings.defaults.thinkingLevel}`)) }}</SelectItem>
            <SelectItem v-for="lvl in SETTINGS_THINKING_LEVELS" :key="lvl" :value="lvl">
              {{ $t(`settings.thinkingLevelOptions.${lvl}`) }}
            </SelectItem>
          </SelectContent>
        </Select>
        <p class="text-xs text-muted-foreground">{{ $t('settings.thinkingLevelHint') }}</p>
      </div>

      <div class="flex flex-col gap-2">
        <Label for="user-language">{{ $t('settings.language') }}</Label>
        <Select :model-value="settings.overrides.language ?? DEFAULT_VALUE" :disabled="saving" @update:model-value="(v) => handleLanguageChange(v as string)">
          <SelectTrigger id="user-language">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem :value="DEFAULT_VALUE">{{ defaultLabel(languageLabel(settings.defaults.language)) }}</SelectItem>
            <SelectItem v-for="lang in LANGUAGE_OPTIONS" :key="lang.value" :value="lang.value">{{ languageLabel(lang.value) }}</SelectItem>
          </SelectContent>
        </Select>
        <p class="text-xs text-muted-foreground">{{ $t('settings.userAgent.languageHint') }}</p>
      </div>

      <div class="flex flex-col gap-2">
        <Label for="user-timezone">{{ $t('settings.timezone') }}</Label>
        <Select :model-value="settings.overrides.timezone ?? DEFAULT_VALUE" :disabled="saving" @update:model-value="(v) => handleTimezoneChange(v as string)">
          <SelectTrigger id="user-timezone">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem :value="DEFAULT_VALUE">{{ defaultLabel(settings.defaults.timezone) }}</SelectItem>
            <SelectItem v-for="tz in timezoneOptions" :key="tz" :value="tz">{{ tz }}</SelectItem>
          </SelectContent>
        </Select>
        <p class="text-xs text-muted-foreground">{{ $t('settings.userAgent.timezoneHint') }}</p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { SETTINGS_THINKING_LEVELS, type SettingsThinkingLevel } from '@axiom/core/contracts'
import { useSettingsApi } from '~/api/settings'
import { LANGUAGE_OPTIONS, TIMEZONE_OPTIONS } from '~/utils/settingsOptions'
import type { OwnSettings, OwnSettingsUpdate, SelectableChatProvider } from '~/api/settings'

const DEFAULT_VALUE = '__default__'

const { t } = useI18n()
const api = useSettingsApi()

const settings = ref<OwnSettings | null>(null)
const providers = ref<SelectableChatProvider[]>([])
const loading = ref(true)
const saving = ref(false)
const error = ref<string | null>(null)
const saved = ref(false)

const timezoneOptions = computed(() => {
  const own = settings.value?.overrides.timezone
  return own && !TIMEZONE_OPTIONS.includes(own) ? [own, ...TIMEZONE_OPTIONS] : TIMEZONE_OPTIONS
})

const modelOptions = computed(() => providers.value.flatMap(provider =>
  provider.models.map(model => ({
    value: `${provider.id}:${model.id}`,
    label: `${provider.name} · ${model.name}`,
  })),
))

const modelValue = computed(() => {
  const own = settings.value?.overrides.chatModel
  return own ? `${own.providerId}:${own.modelId}` : DEFAULT_VALUE
})

const defaultModelLabel = computed(() => {
  const model = settings.value?.defaults.chatModel
  if (!model) return '—'
  return `${model.providerName ?? model.providerId} · ${model.modelId}`
})

function defaultLabel(value: string): string {
  return t('settings.userAgent.useDefault', { value })
}

function languageLabel(value: string): string {
  const option = LANGUAGE_OPTIONS.find(o => o.value === value)
  return option ? t(`settings.${option.key}`) : value
}

async function save(update: OwnSettingsUpdate) {
  saving.value = true
  error.value = null
  try {
    settings.value = await api.updateOwnSettings(update)
    saved.value = true
    setTimeout(() => { saved.value = false }, 3000)
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    saving.value = false
  }
}

function handleModelChange(value: string) {
  if (value === DEFAULT_VALUE) return save({ chatModel: null })
  const separator = value.indexOf(':')
  return save({ chatModel: { providerId: value.slice(0, separator), modelId: value.slice(separator + 1) } })
}

function handleThinkingChange(value: string) {
  return save({ thinkingLevel: value === DEFAULT_VALUE ? null : value as SettingsThinkingLevel })
}

function handleTimezoneChange(value: string) {
  return save({ timezone: value === DEFAULT_VALUE ? null : value })
}

function handleLanguageChange(value: string) {
  return save({ language: value === DEFAULT_VALUE ? null : value })
}

onMounted(async () => {
  try {
    const [own, models] = await Promise.all([api.getOwnSettings(), api.getChatModels()])
    settings.value = own
    providers.value = models.providers
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    loading.value = false
  }
})
</script>
