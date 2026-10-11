<template>
  <div>
    <div class="mb-8">
      <h2 class="text-lg font-semibold tracking-tight text-foreground">
        {{ $t('settings.notifications.title') }}
      </h2>
      <p class="mt-1 text-sm text-muted-foreground">
        {{ $t('settings.notifications.description') }}
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
    <Alert v-if="notice" variant="success" class="mb-4">
      <AlertDescription>{{ notice }}</AlertDescription>
    </Alert>

    <div v-if="loading" class="flex flex-col gap-6">
      <Skeleton class="h-20 w-full" />
      <Skeleton class="h-14 w-full" />
      <Skeleton class="h-32 w-full" />
    </div>

    <div v-else class="flex flex-col gap-8">
      <section class="flex flex-col gap-3">
        <h3 class="text-sm font-medium text-foreground">{{ $t('settings.notifications.thisDevice') }}</h3>

        <Alert v-if="unsupportedMessage">
          <AlertDescription>{{ unsupportedMessage }}</AlertDescription>
        </Alert>

        <div v-else class="flex flex-col gap-3 rounded-lg border border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div class="flex flex-col gap-0.5">
            <span class="text-sm text-foreground">
              {{ thisDeviceEnabled ? $t('settings.notifications.thisDeviceOn') : $t('settings.notifications.thisDeviceOff') }}
            </span>
            <span v-if="permission === 'denied'" class="text-xs text-destructive">
              {{ $t('settings.notifications.permissionDenied') }}
            </span>
          </div>
          <Button
            v-if="thisDeviceEnabled"
            variant="outline"
            :disabled="busy"
            @click="disable"
          >
            {{ $t('settings.notifications.disable') }}
          </Button>
          <Button
            v-else
            :disabled="busy || permission === 'denied'"
            @click="enable"
          >
            <AppIcon name="bell" size="sm" />
            {{ $t('settings.notifications.enable') }}
          </Button>
        </div>
      </section>

      <div class="flex items-center justify-between rounded-lg border border-border px-4 py-3">
        <div class="flex flex-col gap-0.5 pr-4">
          <Label for="push-show-preview" class="cursor-pointer">{{ $t('settings.notifications.showPreview') }}</Label>
          <p class="text-xs text-muted-foreground">{{ $t('settings.notifications.showPreviewHint') }}</p>
        </div>
        <Switch
          id="push-show-preview"
          :checked="showPreview"
          :disabled="busy"
          @update:checked="(value: boolean) => updateShowPreview(value)"
        />
      </div>

      <section class="flex flex-col gap-3">
        <div class="flex items-center justify-between gap-3">
          <h3 class="text-sm font-medium text-foreground">{{ $t('settings.notifications.devices') }}</h3>
          <Button variant="outline" size="sm" :disabled="busy || devices.length === 0" @click="sendTest">
            <AppIcon name="send" size="sm" />
            {{ $t('settings.notifications.sendTest') }}
          </Button>
        </div>

        <div v-if="devices.length > 0" class="overflow-hidden rounded-lg border border-border">
          <div
            v-for="(device, index) in devices"
            :key="device.id"
            :class="['flex items-center justify-between gap-3 px-4 py-3', index > 0 ? 'border-t border-border' : '']"
          >
            <div class="flex min-w-0 flex-col gap-0.5">
              <div class="flex items-center gap-2">
                <span class="truncate text-sm font-medium text-foreground">{{ device.deviceLabel || $t('settings.notifications.unknownDevice') }}</span>
                <Badge v-if="device.endpoint === currentEndpoint" variant="secondary">{{ $t('settings.notifications.thisDeviceBadge') }}</Badge>
              </div>
              <span class="text-xs text-muted-foreground">
                {{ $t('settings.notifications.addedAt', { date: formatDateTime(device.createdAt) }) }}
                ·
                {{ device.lastSuccessAt
                  ? $t('settings.notifications.lastDelivered', { date: formatDateTime(device.lastSuccessAt) })
                  : $t('settings.notifications.neverDelivered') }}
              </span>
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              class="shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              :aria-label="$t('settings.notifications.removeDevice')"
              :disabled="busy"
              @click="deviceToRemove = device"
            >
              <AppIcon name="trash" class="h-4 w-4" />
            </Button>
          </div>
        </div>
        <p v-else class="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
          {{ $t('settings.notifications.noDevices') }}
        </p>
      </section>
    </div>

    <ConfirmDialog
      :open="deviceToRemove !== null"
      :title="$t('settings.notifications.removeDeviceTitle')"
      :description="$t('settings.notifications.removeDeviceDescription', { device: deviceToRemove?.deviceLabel || $t('settings.notifications.unknownDevice') })"
      :confirm-label="$t('settings.notifications.removeDevice')"
      destructive
      :loading="busy"
      @confirm="confirmRemove"
      @cancel="deviceToRemove = null"
    />
  </div>
</template>

<script setup lang="ts">
import type { PushDevice } from '~/api/push'
import { usePushNotifications } from '../composables/usePushNotifications'

const { t } = useI18n()
const { formatDateTime } = useFormat()
const {
  support,
  permission,
  devices,
  showPreview,
  currentEndpoint,
  thisDeviceEnabled,
  loading,
  busy,
  error,
  notice,
  load,
  enable,
  disable,
  removeDevice,
  sendTest,
  updateShowPreview,
} = usePushNotifications()

const deviceToRemove = ref<PushDevice | null>(null)

const unsupportedMessage = computed(() => {
  if (support.value === 'insecure-context') return t('settings.notifications.insecureContext')
  if (support.value === 'ios-needs-install') return t('settings.notifications.iosNeedsInstall')
  if (support.value === 'unsupported') return t('settings.notifications.unsupported')
  return null
})

async function confirmRemove() {
  if (!deviceToRemove.value) return
  await removeDevice(deviceToRemove.value)
  deviceToRemove.value = null
}

onMounted(load)
</script>
