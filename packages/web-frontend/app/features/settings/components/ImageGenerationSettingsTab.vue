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
            <div class="min-w-0" :class="model.disabled ? 'opacity-60' : ''">
              <div class="flex items-center gap-2">
                <span class="text-sm font-medium text-foreground">{{ model.displayName }}</span>
                <Badge v-if="model.disabled" variant="outline" class="px-1.5 py-0 text-[10px]">
                  {{ $t('providers.disabled') }}
                </Badge>
              </div>
              <div class="truncate font-mono text-[11px] text-muted-foreground">
                <NuxtLink
                  :to="{ path: '/providers', query: { provider: model.providerId } }"
                  class="underline-offset-2 hover:text-foreground hover:underline"
                >{{ model.providerName }}</NuxtLink> · {{ model.modelId }}
              </div>
              <p class="mt-1 text-xs" :class="model.description ? 'text-muted-foreground' : 'italic text-muted-foreground/70'">
                {{ model.description || $t('settings.imageGenerationModelNoDescription') }}
              </p>
            </div>
            <div class="flex shrink-0 items-center gap-2">
              <Button
                variant="ghost"
                size="icon-sm"
                :aria-label="$t('providers.editModelMenu')"
                :title="$t('providers.editModelMenu')"
                @click="openEdit(model)"
              >
                <AppIcon name="edit" class="h-4 w-4" />
              </Button>
              <Switch
                :checked="!model.disabled"
                :disabled="togglingKey === modelKey(model)"
                :aria-label="model.disabled ? $t('providers.enable') : $t('providers.disable')"
                @update:checked="(enabled: boolean) => toggleModel(model, enabled)"
              />
            </div>
          </li>
        </ul>
      </div>
    </div>

    <EditImageModelDialog
      :open="!!editTarget"
      :provider="editTarget?.provider ?? null"
      :model-id="editTarget?.modelId ?? null"
      @close="editTarget = null"
    />
  </div>
</template>

<script setup lang="ts">
import { IMAGE_GENERATION_MAX_VARIANTS_BOUNDS } from '@axiom/core/contracts'
import type { ImageGenerationSettings } from '~/composables/useSettings'
import type { Provider } from '~/features/providers/composables/useProviders'
import { buildImageModelOptions, listImageModels, type ImageModelOverviewEntry } from '~/utils/providerModelOptions'

const props = defineProps<{
  providers: Provider[]
}>()

const settings = defineModel<ImageGenerationSettings>({ required: true })

const { updateProviderModel } = useProviders()

const imageModels = computed(() => listImageModels(props.providers))
const imageModelOptions = computed(() => buildImageModelOptions(props.providers))

const editTarget = ref<{ provider: Provider; modelId: string } | null>(null)
const togglingKey = ref<string | null>(null)

function modelKey(model: ImageModelOverviewEntry): string {
  return `${model.providerId}:${model.modelId}`
}

function openEdit(model: ImageModelOverviewEntry) {
  const provider = props.providers.find(p => p.id === model.providerId)
  if (provider) editTarget.value = { provider, modelId: model.modelId }
}

async function toggleModel(model: ImageModelOverviewEntry, enabled: boolean) {
  togglingKey.value = modelKey(model)
  try {
    await updateProviderModel(model.providerId, model.modelId, { disabled: !enabled, modelType: 'image' })
  } finally {
    togglingKey.value = null
  }
}

watch(imageModelOptions, (options) => {
  const current = settings.value.defaultModel
  if (current && !options.some(opt => opt.value === current)) settings.value.defaultModel = ''
})
</script>
