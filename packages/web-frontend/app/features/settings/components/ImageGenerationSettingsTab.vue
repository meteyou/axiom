<template>
  <div>
    <div class="mb-8">
      <h2 class="text-lg font-semibold tracking-tight text-foreground">
        {{ $t('settings.tabs.imageGeneration') }}
      </h2>
      <p class="mt-1 text-sm text-muted-foreground">
        {{ $t('settings.tabs.imageGenerationDescription') }}
      </p>
    </div>

    <div class="flex flex-col gap-8">
      <div class="flex items-center justify-between rounded-lg border border-border px-4 py-3">
        <div class="flex flex-col gap-0.5 pr-4">
          <Label for="image-generation-enabled" class="cursor-pointer">
            {{ $t('settings.imageGenerationEnabled') }}
          </Label>
          <p class="text-xs text-muted-foreground">
            {{ $t('settings.imageGenerationEnabledHint') }}
          </p>
        </div>
        <Switch id="image-generation-enabled" v-model:checked="settings.enabled" />
      </div>

      <template v-if="settings.enabled">
        <div class="flex flex-col gap-2">
          <Label for="image-generation-default-model">{{ $t('settings.imageGenerationDefaultModel') }}</Label>
          <Select v-model="settings.defaultModel" :disabled="imageModelOptions.length === 0">
            <SelectTrigger id="image-generation-default-model">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">{{ $t('settings.imageGenerationDefaultModelFirst') }}</SelectItem>
              <SelectItem v-for="opt in imageModelOptions" :key="opt.value" :value="opt.value">
                {{ opt.label }}
              </SelectItem>
            </SelectContent>
          </Select>
          <p class="text-xs text-muted-foreground">
            {{ imageModelOptions.length === 0 ? $t('settings.imageGenerationDefaultModelNone') : $t('settings.imageGenerationDefaultModelHint') }}
          </p>
        </div>

        <div class="flex flex-col gap-2">
          <Label for="image-generation-max-variants">{{ $t('settings.imageGenerationMaxVariants') }}</Label>
          <Input
            id="image-generation-max-variants"
            v-model.number="settings.maxVariants"
            type="number"
            :min="IMAGE_GENERATION_MAX_VARIANTS_BOUNDS.min"
            :max="IMAGE_GENERATION_MAX_VARIANTS_BOUNDS.max"
            class="w-full"
          />
          <p class="text-xs text-muted-foreground">
            {{ $t('settings.imageGenerationMaxVariantsHint', IMAGE_GENERATION_MAX_VARIANTS_BOUNDS) }}
          </p>
        </div>

        <div class="flex flex-col gap-2">
          <Label for="image-generation-max-cost">{{ $t('settings.imageGenerationMaxCost') }}</Label>
          <div class="flex items-center gap-2">
            <Input
              id="image-generation-max-cost"
              v-model="maxCostInput"
              type="number"
              min="0.01"
              step="0.01"
              :placeholder="$t('settings.imageGenerationMaxCostOff')"
              class="w-full"
            />
            <span class="text-sm text-muted-foreground">USD</span>
          </div>
          <p class="text-xs text-muted-foreground">{{ $t('settings.imageGenerationMaxCostHint') }}</p>
        </div>

        <div class="flex flex-col gap-2">
          <Label for="image-generation-output-dir">{{ $t('settings.imageGenerationOutputDir') }}</Label>
          <Input
            id="image-generation-output-dir"
            v-model="settings.outputDir"
            class="w-full font-mono"
            placeholder="images"
          />
          <p class="text-xs text-muted-foreground">{{ $t('settings.imageGenerationOutputDirHint') }}</p>
        </div>
      </template>

      <Separator />

      <div class="flex flex-col gap-3">
        <div>
          <h3 class="text-base font-semibold tracking-tight text-foreground">
            {{ $t('settings.imageGenerationModels') }}
          </h3>
          <p class="mt-1 text-sm text-muted-foreground">
            {{ $t('settings.imageGenerationModelsHint') }}
          </p>
        </div>

        <p v-if="imageModels.length === 0" class="text-sm text-muted-foreground">
          {{ $t('settings.imageGenerationDefaultModelNone') }}
        </p>
        <ul v-else class="flex flex-col divide-y divide-border rounded-lg border border-border">
          <li
            v-for="model in imageModels"
            :key="`${model.providerId}:${model.modelId}`"
            class="flex items-start justify-between gap-3 px-4 py-3"
          >
            <div class="min-w-0">
              <div class="text-sm font-medium text-foreground">{{ model.displayName }}</div>
              <div class="truncate font-mono text-[11px] text-muted-foreground">{{ model.providerName }} · {{ model.modelId }}</div>
              <p class="mt-1 text-xs" :class="model.description ? 'text-muted-foreground' : 'italic text-muted-foreground/70'">
                {{ model.description || $t('settings.imageGenerationModelNoDescription') }}
              </p>
            </div>
            <Button as-child variant="ghost" size="sm" class="shrink-0">
              <NuxtLink :to="{ path: '/providers', query: { provider: model.providerId } }">
                {{ model.providerName }}
                <AppIcon name="externalLink" size="sm" />
              </NuxtLink>
            </Button>
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { IMAGE_GENERATION_MAX_VARIANTS_BOUNDS } from '@axiom/core/contracts'
import type { ImageGenerationSettings } from '~/composables/useSettings'
import { buildImageModelOptions, listUsableImageModels, type ProviderModelSource } from '~/utils/providerModelOptions'

const props = defineProps<{
  providers: ProviderModelSource[]
}>()

const settings = defineModel<ImageGenerationSettings>({ required: true })

const imageModels = computed(() => listUsableImageModels(props.providers))
const imageModelOptions = computed(() => buildImageModelOptions(props.providers))

const maxCostInput = computed<string>({
  get: () => settings.value.maxCostPerCallUsd === null ? '' : String(settings.value.maxCostPerCallUsd),
  set: (value) => {
    const trimmed = String(value ?? '').trim()
    settings.value.maxCostPerCallUsd = trimmed === '' ? null : Number(trimmed)
  },
})
</script>
