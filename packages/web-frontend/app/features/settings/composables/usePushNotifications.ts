import { usePushApi } from '~/api/push'
import type { PushDeliveryResult, PushDevice } from '~/api/push'
import {
  describeDevice,
  detectPushSupport,
  matchesServerKey,
  readPushEnvironment,
  serviceWorkerUrl,
  urlBase64ToUint8Array,
} from '~/utils/pushSupport'
import type { PushSupport } from '~/utils/pushSupport'

const LOGOUT_CLEANUP_TIMEOUT_MS = 3000

async function getBrowserSubscription(): Promise<PushSubscription | null> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null
  const registration = await navigator.serviceWorker.getRegistration()
  return registration ? registration.pushManager.getSubscription() : null
}

async function ensureRegistration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration()
  if (!existing) await navigator.serviceWorker.register(serviceWorkerUrl(import.meta.dev), { scope: '/' })
  return navigator.serviceWorker.ready
}

export function usePushNotifications() {
  const api = usePushApi()
  const { t, locale } = useI18n()

  const support = ref<PushSupport>('unsupported')
  const permission = ref<NotificationPermission>('default')
  const devices = ref<PushDevice[]>([])
  const showPreview = ref(false)
  const currentEndpoint = ref<string | null>(null)
  const loading = ref(true)
  const busy = ref(false)
  const error = ref<string | null>(null)
  const notice = ref<string | null>(null)

  const thisDeviceEnabled = computed(() =>
    !!currentEndpoint.value && devices.value.some(device => device.endpoint === currentEndpoint.value))

  function flashNotice(message: string) {
    notice.value = message
    setTimeout(() => {
      if (notice.value === message) notice.value = null
    }, 3000)
  }

  async function run(action: () => Promise<void>) {
    busy.value = true
    error.value = null
    try {
      await action()
    } catch (err) {
      error.value = (err as Error).message
    } finally {
      busy.value = false
    }
  }

  async function refreshDevices() {
    const result = await api.listDevices()
    devices.value = result.devices
    showPreview.value = result.showPreview
  }

  async function load() {
    loading.value = true
    error.value = null
    support.value = detectPushSupport(readPushEnvironment())
    if ('Notification' in window) permission.value = Notification.permission
    try {
      await refreshDevices()
      currentEndpoint.value = support.value === 'supported' ? (await getBrowserSubscription())?.endpoint ?? null : null
    } catch (err) {
      error.value = (err as Error).message
    } finally {
      loading.value = false
    }
  }

  async function enable() {
    error.value = null
    // Must be the first await: iOS only shows the prompt while the click still counts as a user gesture.
    permission.value = await Notification.requestPermission()
    if (permission.value !== 'granted') {
      error.value = t('settings.notifications.permissionNotGranted')
      return
    }
    await run(async () => {
      const registration = await ensureRegistration()
      const { publicKey } = await api.getPublicKey()
      let subscription = await registration.pushManager.getSubscription()
      // A subscription made with an older server key can no longer be delivered to.
      if (subscription && !matchesServerKey(subscription.options.applicationServerKey, publicKey)) {
        await subscription.unsubscribe()
        subscription = null
      }
      subscription ??= await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      })
      const environment = readPushEnvironment()
      await api.subscribe(subscription.toJSON(), describeDevice(environment.userAgent, environment.standalone), locale.value)
      currentEndpoint.value = subscription.endpoint
      await refreshDevices()
      flashNotice(t('settings.notifications.enabledNotice'))
    })
  }

  async function disable() {
    await run(async () => {
      const subscription = await getBrowserSubscription()
      const device = devices.value.find(entry => entry.endpoint === subscription?.endpoint)
      if (device) await api.removeDevice(device.id)
      await subscription?.unsubscribe()
      currentEndpoint.value = null
      await refreshDevices()
    })
  }

  async function removeDevice(device: PushDevice) {
    await run(async () => {
      await api.removeDevice(device.id)
      if (device.endpoint === currentEndpoint.value) {
        await (await getBrowserSubscription())?.unsubscribe()
        currentEndpoint.value = null
      }
      await refreshDevices()
    })
  }

  function summarizeTest(results: PushDeliveryResult[]): string {
    if (results.length === 0) return t('settings.notifications.testNoDevices')
    const sent = results.filter(result => result.status === 'sent').length
    const removed = results.filter(result => result.status === 'removed').length
    const failed = results.find(result => result.status === 'failed')
    const parts = [t('settings.notifications.testSent', { sent, total: results.length })]
    if (removed > 0) parts.push(t('settings.notifications.testRemoved', { count: removed }))
    if (failed) parts.push(t('settings.notifications.testFailed', { device: failed.deviceLabel ?? `#${failed.subscriptionId}`, error: failed.error ?? String(failed.statusCode ?? '') }))
    return parts.join(' ')
  }

  async function sendTest() {
    await run(async () => {
      const { results } = await api.sendTest()
      const summary = summarizeTest(results)
      if (results.some(result => result.status === 'failed')) error.value = summary
      else flashNotice(summary)
      await refreshDevices()
    })
  }

  async function updateShowPreview(value: boolean) {
    await run(async () => {
      showPreview.value = (await api.setShowPreview(value)).showPreview
    })
  }

  return {
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
  }
}

/**
 * Logging out removes this browser's subscription, so the next person using
 * the device does not receive the previous user's notifications. Best effort
 * and time-boxed: a slow or failing request must never block the logout.
 */
export function usePushLogoutCleanup() {
  const api = usePushApi()

  async function forgetThisDevice(): Promise<void> {
    const cleanup = (async () => {
      const subscription = await getBrowserSubscription()
      if (!subscription) return
      try {
        const { devices } = await api.listDevices()
        const device = devices.find(entry => entry.endpoint === subscription.endpoint)
        if (device) await api.removeDevice(device.id)
      } finally {
        await subscription.unsubscribe()
      }
    })().catch(() => {})
    await Promise.race([cleanup, new Promise(resolve => setTimeout(resolve, LOGOUT_CLEANUP_TIMEOUT_MS))])
  }

  return { forgetThisDevice }
}
