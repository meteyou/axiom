import {
  deleteOwnPushSubscription,
  getPushPreviewEnabled,
  listPushSubscriptions,
  savePushSubscription,
  setPushPreviewEnabled,
} from '@axiom/core'
import type { Database, PushSubscriptionRecord } from '@axiom/core'
import type { PushDeliveryResult, PushNotifier } from '../../../push/push-notifier.js'
import { buildTestNotificationPayload } from '../../../push/turn-push.js'
import type { SubscribeInput } from './schema.js'

export class PushUnavailableError extends Error {}
export class PushSubscriptionNotFoundError extends Error {}

export interface SubscribeContext {
  userAgent: string | null
  origin: string | null
}

export interface PushService {
  getPublicKey: () => string
  listDevices: (userId: number) => { devices: PushSubscriptionRecord[]; showPreview: boolean }
  subscribe: (userId: number, input: SubscribeInput, context: SubscribeContext) => PushSubscriptionRecord
  removeDevice: (userId: number, id: number) => void
  sendTest: (userId: number) => Promise<PushDeliveryResult[]>
  setShowPreview: (userId: number, showPreview: boolean) => boolean
}

export function createPushService(options: { db: Database; notifier: PushNotifier }): PushService {
  const { db, notifier } = options

  return {
    getPublicKey() {
      try {
        return notifier.getPublicKey()
      } catch (err) {
        throw new PushUnavailableError((err as Error).message)
      }
    },

    listDevices(userId) {
      return { devices: listPushSubscriptions(db, userId), showPreview: getPushPreviewEnabled(db, userId) }
    },

    subscribe(userId, input, context) {
      return savePushSubscription(db, {
        userId,
        endpoint: input.endpoint,
        keys: input.keys,
        deviceLabel: input.deviceLabel,
        locale: input.locale,
        userAgent: context.userAgent,
        origin: context.origin,
      })
    },

    removeDevice(userId, id) {
      if (!deleteOwnPushSubscription(db, userId, id)) {
        throw new PushSubscriptionNotFoundError('Device not found')
      }
    },

    async sendTest(userId) {
      try {
        return await notifier.sendToUser(userId, device => buildTestNotificationPayload(device.locale))
      } catch (err) {
        throw new PushUnavailableError((err as Error).message)
      }
    },

    setShowPreview(userId, showPreview) {
      setPushPreviewEnabled(db, userId, showPreview)
      return getPushPreviewEnabled(db, userId)
    },
  }
}
