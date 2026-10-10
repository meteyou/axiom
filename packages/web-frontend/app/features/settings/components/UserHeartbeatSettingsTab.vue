<template>
  <div>
    <div v-if="!switchOnly" class="mb-8">
      <h2 class="text-lg font-semibold tracking-tight text-foreground">
        {{ $t('settings.userHeartbeat.title') }}
      </h2>
      <p class="mt-1 text-sm text-muted-foreground">
        {{ $t('settings.userHeartbeat.description') }}
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
      <AlertDescription>{{ $t('settings.userHeartbeat.saved') }}</AlertDescription>
    </Alert>

    <div v-if="loading" class="flex flex-col gap-6">
      <Skeleton class="h-14 w-full" />
      <Skeleton class="h-40 w-full" />
    </div>

    <div v-else-if="settings" class="flex flex-col gap-8">
      <Alert v-if="!switchOnly && !settings.masterEnabled">
        <AlertDescription>{{ $t('settings.userHeartbeat.masterOff') }}</AlertDescription>
      </Alert>

      <div class="flex items-center justify-between rounded-lg border border-border px-4 py-3">
        <div class="flex flex-col gap-0.5 pr-4">
          <Label for="user-heartbeat-enabled" class="cursor-pointer">{{ $t('settings.userHeartbeat.enabled') }}</Label>
          <p class="text-xs text-muted-foreground">{{ $t('settings.userHeartbeat.enabledHint') }}</p>
        </div>
        <Switch
          id="user-heartbeat-enabled"
          :checked="settings.enabled"
          :disabled="saving"
          @update:checked="(v: boolean) => toggle(v)"
        />
      </div>

      <dl v-if="!switchOnly" class="grid grid-cols-1 gap-3 rounded-lg border border-border bg-muted/30 px-4 py-3 text-sm sm:grid-cols-2">
        <div>
          <dt class="text-xs text-muted-foreground">{{ $t('settings.userHeartbeat.interval') }}</dt>
          <dd class="text-foreground">{{ $t('settings.userHeartbeat.intervalValue', { minutes: settings.intervalMinutes }) }}</dd>
        </div>
        <div>
          <dt class="text-xs text-muted-foreground">{{ $t('settings.userHeartbeat.nightMode') }}</dt>
          <dd class="text-foreground">{{ nightModeLabel }}</dd>
        </div>
      </dl>

      <div v-if="!switchOnly" class="flex flex-col gap-2">
        <Label for="user-heartbeat-content">{{ $t('settings.userHeartbeat.editor') }}</Label>
        <textarea
          id="user-heartbeat-content"
          v-model="content"
          rows="14"
          class="flex w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <div>
          <Button :disabled="saving" @click="saveContent">{{ $t('settings.userHeartbeat.save') }}</Button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useMemoryApi } from '~/api/memory'
import type { MemoryHeartbeatSettings } from '~/api/memory'

const props = defineProps<{ switchOnly?: boolean }>()

const { t } = useI18n()
const api = useMemoryApi()

const settings = ref<MemoryHeartbeatSettings | null>(null)
const content = ref('')
const loading = ref(true)
const saving = ref(false)
const error = ref<string | null>(null)
const saved = ref(false)

const nightModeLabel = computed(() => {
  const night = settings.value?.nightMode
  if (!night?.enabled) return t('settings.userHeartbeat.nightModeOff')
  return t('settings.userHeartbeat.nightModeValue', { start: night.startHour, end: night.endHour, timezone: settings.value?.timezone })
})

function flashSaved() {
  saved.value = true
  setTimeout(() => { saved.value = false }, 3000)
}

async function run(action: () => Promise<void>) {
  saving.value = true
  error.value = null
  try {
    await action()
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    saving.value = false
  }
}

const toggle = (enabled: boolean) => run(async () => {
  settings.value = await api.updateHeartbeatSettings(enabled)
  flashSaved()
})

const saveContent = () => run(async () => {
  await api.updateHeartbeat(content.value)
  flashSaved()
})

onMounted(async () => {
  try {
    const [loadedSettings, file] = await Promise.all([api.getHeartbeatSettings(), props.switchOnly ? Promise.resolve({ content: '' }) : api.getHeartbeat()])
    settings.value = loadedSettings
    content.value = file.content
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    loading.value = false
  }
})
</script>
