import webpush from 'web-push'
import type { RequestOptions, SendResult } from 'web-push'
import {
  deletePushSubscriptionByEndpoint,
  listPushSubscriptions,
  markPushSubscriptionDelivered,
} from '@axiom/core'
import type { Database, PushSubscriptionRecord } from '@axiom/core'
import { loadOrCreateVapidKeys } from './vapid-keys.js'
import type { VapidKeys } from './vapid-keys.js'

export type PushNotificationKind = 'chat_reply' | 'chat_error' | 'test'

/** What the service worker receives; it renders `title`/`body` and opens `url` on click. */
export interface PushNotificationPayload {
  kind: PushNotificationKind
  title: string
  body: string
  url: string
  tag: string
}

export type PushDeliveryStatus = 'sent' | 'removed' | 'failed'

export interface PushDeliveryResult {
  subscriptionId: number
  deviceLabel: string | null
  status: PushDeliveryStatus
  statusCode?: number
  error?: string
}

export type SendPushFn = (
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  payload: string,
  options: RequestOptions,
) => Promise<Pick<SendResult, 'statusCode'>>

export interface PushNotifier {
  /** Throws when the VAPID keys cannot be loaded or created. */
  getPublicKey: () => string
  sendToUser: (
    userId: number,
    buildPayload: (device: PushSubscriptionRecord) => PushNotificationPayload,
  ) => Promise<PushDeliveryResult[]>
}

export interface PushNotifierOptions {
  db: Database
  loadKeys?: () => VapidKeys
  send?: SendPushFn
  logger?: Pick<typeof console, 'warn'>
}

/** Undelivered notifications expire after a day: a reply that old is no longer news. */
const PUSH_TTL_SECONDS = 24 * 60 * 60

/**
 * Apple's push service rejects VAPID tokens whose subject is not a public
 * `https:` URL or `mailto:` address (403 BadJwtToken). Only used when the
 * device subscribed from a non-HTTPS origin, which iOS never does.
 */
const FALLBACK_VAPID_SUBJECT = 'mailto:push@example.com'

export function resolveVapidSubject(configured: string | null, deviceOrigin: string | null): string {
  if (configured) return configured
  if (!deviceOrigin) return FALLBACK_VAPID_SUBJECT
  try {
    const url = new URL(deviceOrigin)
    if (url.protocol === 'https:' && url.hostname !== 'localhost') return url.origin
  } catch {
    // An unparsable stored origin falls through to the fallback.
  }
  return FALLBACK_VAPID_SUBJECT
}

/** The subscription is gone for good (unsubscribed, expired, app uninstalled). */
function isSubscriptionGone(statusCode: number | undefined): boolean {
  return statusCode === 404 || statusCode === 410
}

export function createPushNotifier(options: PushNotifierOptions): PushNotifier {
  const loadKeys = options.loadKeys ?? (() => loadOrCreateVapidKeys())
  const send: SendPushFn = options.send ?? ((subscription, payload, requestOptions) => webpush.sendNotification(subscription, payload, requestOptions))
  const logger = options.logger ?? console
  let cachedKeys: VapidKeys | null = null

  function keys(): VapidKeys {
    cachedKeys ??= loadKeys()
    return cachedKeys
  }

  async function deliver(device: PushSubscriptionRecord, payload: PushNotificationPayload): Promise<PushDeliveryResult> {
    const vapid = keys()
    const base = { subscriptionId: device.id, deviceLabel: device.deviceLabel }
    try {
      await send(
        { endpoint: device.endpoint, keys: device.keys },
        JSON.stringify(payload),
        {
          TTL: PUSH_TTL_SECONDS,
          urgency: 'normal',
          vapidDetails: {
            subject: resolveVapidSubject(vapid.subject, device.origin),
            publicKey: vapid.publicKey,
            privateKey: vapid.privateKey,
          },
        },
      )
      markPushSubscriptionDelivered(options.db, device.id)
      return { ...base, status: 'sent' }
    } catch (err) {
      const statusCode = (err as { statusCode?: number }).statusCode
      const body = (err as { body?: string }).body
      const error = [(err as Error).message, body].filter(Boolean).join(' — ')
      if (isSubscriptionGone(statusCode)) {
        deletePushSubscriptionByEndpoint(options.db, device.endpoint)
        return { ...base, status: 'removed', statusCode, error }
      }
      logger.warn(`[push] Delivery to subscription ${device.id} (user ${device.userId}) failed${statusCode ? ` with ${statusCode}` : ''}: ${error}`)
      return { ...base, status: 'failed', statusCode, error }
    }
  }

  return {
    getPublicKey: () => keys().publicKey,
    async sendToUser(userId, buildPayload) {
      const devices = listPushSubscriptions(options.db, userId)
      if (devices.length === 0) return []
      return Promise.all(devices.map(device => deliver(device, buildPayload(device))))
    },
  }
}
