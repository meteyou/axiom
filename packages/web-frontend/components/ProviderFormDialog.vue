<template>
  <Dialog :open="open" @update:open="(v: boolean) => { if (!v) emit('close') }">
    <DialogContent class="max-w-lg">
      <DialogHeader>
        <DialogTitle>{{ mode === 'edit' ? $t('providers.editProvider') : $t('providers.addProvider') }}</DialogTitle>
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
            required
          />
        </div>

        <!-- Type -->
        <div class="flex flex-col gap-1.5">
          <Label for="provider-type">{{ $t('providers.type') }}</Label>
          <Select
            id="provider-type"
            v-model="form.providerType"
            required
            @change="onTypeChange"
          >
            <option value="" disabled>{{ $t('providers.selectType') }}</option>
            <option v-for="(preset, key) in presets" :key="key" :value="key">
              {{ preset.label }}
            </option>
          </Select>
        </div>

        <!-- Base URL -->
        <div class="flex flex-col gap-1.5">
          <Label for="provider-url">{{ $t('providers.baseUrl') }}</Label>
          <Input
            id="provider-url"
            v-model="form.baseUrl"
            type="url"
            placeholder="https://..."
          />
        </div>

        <!-- API Key -->
        <div class="flex flex-col gap-1.5">
          <Label for="provider-key">{{ $t('providers.apiKey') }}</Label>
          <Input
            id="provider-key"
            v-model="form.apiKey"
            type="password"
            :placeholder="mode === 'edit' ? $t('providers.apiKeyHint') : $t('providers.apiKeyPlaceholder')"
          />
          <p v-if="mode === 'edit'" class="text-xs text-muted-foreground">{{ $t('providers.apiKeyHint') }}</p>
        </div>

        <!-- Model -->
        <div class="flex flex-col gap-1.5">
          <Label for="provider-model">{{ $t('providers.model') }}</Label>
          <Input
            id="provider-model"
            v-model="form.defaultModel"
            type="text"
            :placeholder="$t('providers.modelPlaceholder')"
            required
          />
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" @click="emit('close')">{{ $t('providers.cancel') }}</Button>
          <Button type="submit">{{ $t('providers.save') }}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import type { Provider, ProviderTypePreset } from '~/composables/useProviders'

export interface ProviderFormPayload {
  name: string
  providerType: string
  baseUrl: string
  apiKey: string
  defaultModel: string
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
}>()

const form = reactive({
  name: '',
  providerType: '',
  baseUrl: '',
  apiKey: '',
  defaultModel: '',
})

// Sync form state when dialog opens or provider changes
watch(() => [props.open, props.provider] as const, ([isOpen, entry]) => {
  if (isOpen && props.mode === 'edit' && entry) {
    form.name = entry.name
    form.providerType = entry.providerType
    form.baseUrl = entry.baseUrl
    form.apiKey = ''
    form.defaultModel = entry.defaultModel
  } else if (isOpen && props.mode === 'create') {
    form.name = ''
    form.providerType = ''
    form.baseUrl = ''
    form.apiKey = ''
    form.defaultModel = ''
  }
}, { immediate: true })

function onTypeChange() {
  const preset = props.presets[form.providerType]
  if (preset && props.mode !== 'edit') {
    form.baseUrl = preset.baseUrl
  }
}

function handleSubmit() {
  emit('submit', { ...form })
}
</script>
