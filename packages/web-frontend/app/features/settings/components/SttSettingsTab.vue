<template>
  <div>
    <div class="mb-8">
      <h2 class="text-lg font-semibold tracking-tight text-foreground">
        {{ $t('settings.sttTitle') }}
      </h2>
      <p class="mt-1 text-sm text-muted-foreground">
        {{ $t('settings.sttSubtitle') }}
      </p>
    </div>

    <div class="flex flex-col gap-8">
      <div class="flex items-center justify-between rounded-lg border border-border px-4 py-3">
        <div class="flex flex-col gap-0.5 pr-4">
          <Label for="stt-enabled" class="cursor-pointer">
            {{ $t('settings.sttEnabled') }}
          </Label>
          <p class="text-xs text-muted-foreground">
            {{ $t('settings.sttEnabledHint') }}
          </p>
        </div>
        <Switch id="stt-enabled" v-model:checked="settings.enabled" />
      </div>

      <template v-if="settings.enabled">
        <div class="flex flex-col gap-2">
          <Label for="stt-model">{{ $t('settings.sttModel') }}</Label>
          <Select v-model="settings.model" :disabled="modelOptions.length === 0">
            <SelectTrigger id="stt-model">
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
              {{ $t('settings.sttModelNone') }}
              <NuxtLink to="/providers" class="underline underline-offset-2 hover:text-foreground">{{ $t('settings.voiceModelProvidersLink') }}</NuxtLink>
            </template>
            <template v-else>{{ $t('settings.sttModelHint') }}</template>
          </p>
        </div>

        <div class="flex flex-col gap-2">
          <Label for="stt-language">{{ $t('settings.sttLanguage') }}</Label>
          <Input
            id="stt-language"
            v-model="settings.language"
            :placeholder="$t('settings.sttLanguagePlaceholder')"
          />
          <p class="text-xs text-muted-foreground">{{ $t('settings.sttLanguageHint') }}</p>
        </div>

        <div class="flex items-center justify-between rounded-lg border border-border px-4 py-3">
          <div class="flex flex-col gap-0.5 pr-4">
            <Label for="stt-rewrite-enabled" class="cursor-pointer">
              {{ $t('settings.sttRewriteEnabled') }}
            </Label>
            <p class="text-xs text-muted-foreground">
              {{ $t('settings.sttRewriteEnabledHint') }}
            </p>
          </div>
          <Switch id="stt-rewrite-enabled" v-model:checked="settings.rewrite.enabled" />
        </div>

        <div v-if="settings.rewrite.enabled" class="flex flex-col gap-2">
          <Label for="stt-rewrite-provider">{{ $t('settings.sttRewriteProvider') }}</Label>
          <Select v-model="settings.rewrite.providerId">
            <SelectTrigger id="stt-rewrite-provider">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem v-for="opt in rewriteOptions" :key="opt.value" :value="opt.value">
                {{ opt.label }}
              </SelectItem>
              <SelectItem v-if="rewriteOptions.length === 0" value="" disabled>
                {{ $t('settings.sttRewriteProviderNone') }}
              </SelectItem>
            </SelectContent>
          </Select>
          <p class="text-xs text-muted-foreground">{{ $t('settings.sttRewriteProviderHint') }}</p>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { SttSettings } from '~/composables/useSettings'
import type { Provider } from '~/features/providers/composables/useProviders'
import { buildProviderModelOptions, buildVoiceModelOptions } from '~/utils/providerModelOptions'

const props = defineProps<{
  providers: Provider[]
}>()

const settings = defineModel<SttSettings>({ required: true })

const modelOptions = computed(() => buildVoiceModelOptions(props.providers, 'stt'))
const rewriteOptions = computed(() => buildProviderModelOptions(props.providers))

watch(modelOptions, (options) => {
  const current = settings.value.model
  if (current && !options.some(option => option.value === current)) settings.value.model = ''
})
</script>
