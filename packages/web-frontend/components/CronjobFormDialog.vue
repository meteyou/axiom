<template>
  <Dialog :open="open" @update:open="$emit('close')">
    <DialogContent class="max-w-lg">
      <DialogHeader>
        <DialogTitle>{{ mode === 'create' ? $t('cronjobs.createTitle') : $t('cronjobs.editTitle') }}</DialogTitle>
        <DialogDescription>{{ mode === 'create' ? $t('cronjobs.createDescription') : $t('cronjobs.editDescription') }}</DialogDescription>
      </DialogHeader>

      <form class="space-y-4" @submit.prevent="onSubmit">
        <!-- Name -->
        <div class="space-y-2">
          <Label for="cronjob-name">{{ $t('cronjobs.form.name') }}</Label>
          <Input
            id="cronjob-name"
            v-model="form.name"
            :placeholder="$t('cronjobs.form.namePlaceholder')"
            required
          />
        </div>

        <!-- Prompt -->
        <div class="space-y-2">
          <Label for="cronjob-prompt">{{ $t('cronjobs.form.prompt') }}</Label>
          <textarea
            id="cronjob-prompt"
            v-model="form.prompt"
            rows="4"
            class="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            :placeholder="$t('cronjobs.form.promptPlaceholder')"
            required
          />
        </div>

        <!-- Schedule -->
        <div class="space-y-2">
          <Label for="cronjob-schedule">{{ $t('cronjobs.form.schedule') }}</Label>
          <Input
            id="cronjob-schedule"
            v-model="form.schedule"
            placeholder="0 9 * * *"
            required
          />
          <p class="text-xs text-muted-foreground">
            {{ $t('cronjobs.form.scheduleHelp') }}
          </p>
        </div>

        <!-- Provider -->
        <div class="space-y-2">
          <Label for="cronjob-provider">{{ $t('cronjobs.form.provider') }}</Label>
          <Select id="cronjob-provider" v-model="form.provider">
            <option value="">{{ $t('cronjobs.form.defaultProvider') }}</option>
            <option
              v-for="p in providers"
              :key="p.id"
              :value="p.name"
            >
              {{ p.name }}
            </option>
          </Select>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" @click="$emit('close')">
            {{ $t('common.cancel') }}
          </Button>
          <Button type="submit" :disabled="loading">
            {{ loading ? $t('common.saving') : (mode === 'create' ? $t('common.create') : $t('common.save')) }}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import type { Cronjob } from '~/composables/useCronjobs'

const props = defineProps<{
  open: boolean
  mode: 'create' | 'edit'
  cronjob?: Cronjob | null
  loading: boolean
}>()

const emit = defineEmits<{
  close: []
  submit: [form: { name: string; prompt: string; schedule: string; provider?: string }]
}>()

const { providers, loadProviders } = useProviders()

const form = reactive({
  name: '',
  prompt: '',
  schedule: '',
  provider: '',
})

watch(() => props.open, (isOpen) => {
  if (isOpen) {
    loadProviders()
    if (props.mode === 'edit' && props.cronjob) {
      form.name = props.cronjob.name
      form.prompt = props.cronjob.prompt
      form.schedule = props.cronjob.schedule
      form.provider = props.cronjob.provider ?? ''
    } else {
      form.name = ''
      form.prompt = ''
      form.schedule = ''
      form.provider = ''
    }
  }
})

function onSubmit() {
  emit('submit', {
    name: form.name,
    prompt: form.prompt,
    schedule: form.schedule,
    provider: form.provider || undefined,
  })
}
</script>
