<template>
  <div>
    <div class="mb-8">
      <h2 class="text-lg font-semibold tracking-tight text-foreground">
        {{ $t('settings.ttsTitle') }}
      </h2>
      <p class="mt-1 text-sm text-muted-foreground">
        {{ $t('settings.ttsSubtitle') }}
      </p>
    </div>

    <div class="flex flex-col gap-8">
      <div class="flex items-center justify-between rounded-lg border border-border px-4 py-3">
        <div class="flex flex-col gap-0.5 pr-4">
          <Label for="tts-enabled" class="cursor-pointer">
            {{ $t('settings.ttsEnabled') }}
          </Label>
          <p class="text-xs text-muted-foreground">
            {{ $t('settings.ttsEnabledHint') }}
          </p>
        </div>
        <Switch id="tts-enabled" v-model:checked="settings.enabled" />
      </div>

      <template v-if="settings.enabled">
        <div class="flex items-center justify-between rounded-lg border border-border px-4 py-3">
          <div class="flex flex-col gap-0.5 pr-4">
            <Label for="tts-agent-tool" class="cursor-pointer">
              {{ $t('settings.ttsAgentTool') }}
            </Label>
            <p class="text-xs text-muted-foreground">
              {{ $t('settings.ttsAgentToolHint') }}
            </p>
          </div>
          <Switch id="tts-agent-tool" v-model:checked="settings.agentTool" />
        </div>

        <div class="flex flex-col gap-2">
          <Label for="tts-model">{{ $t('settings.ttsModel') }}</Label>
          <Select v-model="settings.model" :disabled="modelOptions.length === 0">
            <SelectTrigger id="tts-model">
              <SelectValue :placeholder="$t('settings.voiceModelPlaceholder')" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem v-for="opt in modelOptions" :key="opt.value" :value="opt.value">
                {{ opt.label }}
              </SelectItem>
            </SelectContent>
          </Select>
          <p class="text-xs text-muted-foreground">
            <template v-if="modelOptions.length === 0">
              {{ $t('settings.ttsModelNone') }}
              <NuxtLink to="/providers" class="underline underline-offset-2 hover:text-foreground">{{ $t('settings.voiceModelProvidersLink') }}</NuxtLink>
            </template>
            <template v-else>{{ $t('settings.ttsModelHint') }}</template>
          </p>
        </div>

        <div v-if="settings.model" class="flex flex-col gap-2">
          <Label for="tts-voice">{{ $t('settings.ttsVoice') }}</Label>
          <div v-if="voicesLoading" class="flex h-10 items-center gap-2 text-xs text-muted-foreground">
            <span class="h-3 w-3 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
            {{ $t('settings.ttsVoicesLoading') }}
          </div>
          <p v-else-if="voices === null" class="text-sm text-muted-foreground">
            {{ $t('settings.ttsVoiceFromModel') }}
          </p>
          <Select v-else-if="voices.length > 0" v-model="settings.voice">
            <SelectTrigger id="tts-voice">
              <SelectValue :placeholder="$t('settings.ttsVoiceDefault')" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem v-for="voice in voiceOptions" :key="voice.value" :value="voice.value">
                {{ voice.label }}
              </SelectItem>
            </SelectContent>
          </Select>
          <Input
            v-else
            id="tts-voice"
            v-model="settings.voice"
            :placeholder="$t('settings.ttsVoicePlaceholder')"
          />
          <p v-if="voicesError" class="text-xs text-destructive">{{ voicesError }}</p>
          <p v-else-if="voices !== null" class="text-xs text-muted-foreground">{{ $t('settings.ttsVoiceHint') }}</p>
        </div>

        <div v-if="settings.model" class="flex flex-col gap-2">
          <Label for="tts-instructions">{{ $t('settings.ttsInstructions') }}</Label>
          <Input
            id="tts-instructions"
            v-model="settings.instructions"
            :placeholder="$t('settings.ttsInstructionsPlaceholder')"
          />
          <p class="text-xs text-muted-foreground">{{ $t('settings.ttsInstructionsHint') }}</p>
        </div>

        <div v-if="settings.model" class="flex flex-col gap-2">
          <Label for="tts-preview-text">{{ $t('settings.ttsPreview') }}</Label>
          <div class="flex items-end gap-2">
            <Input
              id="tts-preview-text"
              v-model="previewText"
              :placeholder="$t('settings.ttsPreviewPlaceholder')"
              class="flex-1"
              @keydown.enter.prevent="handlePreview"
            />
            <Button
              type="button"
              variant="outline"
              class="shrink-0 gap-2"
              :disabled="previewLoading || (!playing && !previewText.trim())"
              @click="handlePreview"
            >
              <AppIcon v-if="previewLoading" name="loader" size="sm" class="animate-spin" />
              <AppIcon v-else-if="playing" name="square" size="sm" />
              <AppIcon v-else name="volume" size="sm" />
              {{ playing ? $t('settings.ttsPreviewStop') : $t('settings.ttsPreviewPlay') }}
            </Button>
          </div>
          <p v-if="previewError" class="break-words text-xs text-destructive">{{ previewError }}</p>
          <p v-else class="text-xs text-muted-foreground">{{ $t('settings.ttsPreviewHint') }}</p>
        </div>

        <Separator />

        <div class="flex flex-col gap-2">
          <Label for="tts-format">{{ $t('settings.ttsResponseFormat') }}</Label>
          <Select v-if="formatOptions.length > 1" v-model="settings.responseFormat">
            <SelectTrigger id="tts-format">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem v-for="format in formatOptions" :key="format" :value="format">
                {{ FORMAT_LABELS[format] }}
              </SelectItem>
            </SelectContent>
          </Select>
          <p v-else class="text-sm text-foreground">{{ FORMAT_LABELS[settings.responseFormat] }}</p>
          <p class="text-xs text-muted-foreground">
            {{ formatOptions.length > 1 ? $t('settings.ttsResponseFormatHint') : $t('settings.ttsResponseFormatSingle') }}
          </p>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { getSupportedTtsResponseFormats, type TtsResponseFormat } from '@axiom/core/contracts'
import type { TtsSettings } from '~/composables/useSettings'
import type { Provider, VoiceOption } from '~/features/providers/composables/useProviders'
import { useSettingsApi } from '~/api/settings'
import { buildVoiceModelOptions } from '~/utils/providerModelOptions'

const props = defineProps<{
  providers: Provider[]
}>()

const settings = defineModel<TtsSettings>({ required: true })

const { t } = useI18n()
const { fetchTtsVoices } = useProviders()
const settingsApi = useSettingsApi()
const { playing, play, stop } = useAudioPreview()

const modelOptions = computed(() => buildVoiceModelOptions(props.providers, 'tts'))

const FORMAT_LABELS: Record<TtsResponseFormat, string> = {
  mp3: 'MP3',
  wav: 'WAV',
  opus: 'Opus (OGG)',
  flac: 'FLAC',
}

const formatOptions = computed(() => {
  const providerId = splitModelRef(settings.value.model)?.providerId
  return getSupportedTtsResponseFormats(props.providers.find(provider => provider.id === providerId)?.providerType)
})

watch(formatOptions, (formats) => {
  if (!formats.includes(settings.value.responseFormat)) settings.value.responseFormat = formats[0]!
}, { immediate: true })

const voices = ref<VoiceOption[] | null>([])
const voicesLoading = ref(false)
const voicesError = ref('')

const voiceOptions = computed(() => {
  const options = (voices.value ?? []).map(voice => ({
    value: voice.id,
    label: voice.language ? `${voice.name} (${voice.language})` : voice.name,
  }))
  const current = settings.value.voice
  if (current && !options.some(option => option.value === current)) {
    options.unshift({ value: current, label: current })
  }
  return options
})

function splitModelRef(ref: string): { providerId: string; modelId: string } | null {
  const index = ref.indexOf(':')
  if (index <= 0) return null
  return { providerId: ref.slice(0, index), modelId: ref.slice(index + 1) }
}

let voicesRequest = 0

async function loadVoices(modelRef: string) {
  const request = ++voicesRequest
  voicesError.value = ''
  const parsed = splitModelRef(modelRef)
  if (!parsed) {
    voices.value = []
    return
  }
  voicesLoading.value = true
  try {
    const result = await fetchTtsVoices(parsed.providerId, parsed.modelId)
    if (request === voicesRequest) voices.value = result
  } catch (err) {
    if (request === voicesRequest) {
      voices.value = []
      voicesError.value = t('settings.ttsVoicesError', { error: (err as Error).message })
    }
  } finally {
    if (request === voicesRequest) voicesLoading.value = false
  }
}

watch(() => settings.value.model, (model, previous) => {
  if (previous !== undefined && model !== previous) settings.value.voice = ''
  void loadVoices(model)
}, { immediate: true })

watch(modelOptions, (options) => {
  const current = settings.value.model
  if (current && !options.some(option => option.value === current)) settings.value.model = ''
})

const previewText = ref(t('settings.ttsPreviewDefaultText'))
const previewLoading = ref(false)
const previewError = ref('')

async function handlePreview() {
  if (playing.value) {
    stop()
    return
  }
  if (!previewText.value.trim() || previewLoading.value) return
  previewError.value = ''
  previewLoading.value = true
  try {
    const { model, voice, instructions, responseFormat } = settings.value
    const blob = await settingsApi.previewTts({ text: previewText.value, settings: { model, voice, instructions, responseFormat } })
    await play(blob)
  } catch (err) {
    previewError.value = (err as Error).message
  } finally {
    previewLoading.value = false
  }
}
</script>
