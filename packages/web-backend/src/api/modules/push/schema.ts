import { isTrustedPushEndpoint } from '../../../push/push-endpoint.js'

interface ParseSuccess<T> {
  ok: true
  value: T
}

interface ParseFailure {
  ok: false
  error: string
}

export type ParseResult<T> = ParseSuccess<T> | ParseFailure

export interface SubscribeInput {
  endpoint: string
  keys: { p256dh: string; auth: string }
  deviceLabel: string | null
  locale: string | null
}

const MAX_KEY_LENGTH = 256
const MAX_LABEL_LENGTH = 100
const MAX_LOCALE_LENGTH = 16
const BASE64URL = /^[A-Za-z0-9_-]+={0,2}$/

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().slice(0, maxLength)
  return trimmed || null
}

function isKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_KEY_LENGTH && BASE64URL.test(value)
}

/** Accepts the browser's `PushSubscription.toJSON()` shape under `subscription`. */
export function parseSubscribeBody(body: unknown): ParseResult<SubscribeInput> {
  if (!isObject(body) || !isObject(body.subscription)) {
    return { ok: false, error: 'subscription is required' }
  }
  const { endpoint, keys } = body.subscription
  if (!isTrustedPushEndpoint(endpoint)) {
    return { ok: false, error: 'subscription.endpoint must be a URL of a known browser push service' }
  }
  if (!isObject(keys) || !isKey(keys.p256dh) || !isKey(keys.auth)) {
    return { ok: false, error: 'subscription.keys.p256dh and subscription.keys.auth are required' }
  }
  return {
    ok: true,
    value: {
      endpoint,
      keys: { p256dh: keys.p256dh, auth: keys.auth },
      deviceLabel: optionalText(body.deviceLabel, MAX_LABEL_LENGTH),
      locale: optionalText(body.locale, MAX_LOCALE_LENGTH),
    },
  }
}

export function parsePreferencesBody(body: unknown): ParseResult<{ showPreview: boolean }> {
  if (!isObject(body) || typeof body.showPreview !== 'boolean') {
    return { ok: false, error: 'showPreview must be a boolean' }
  }
  return { ok: true, value: { showPreview: body.showPreview } }
}

export function parseSubscriptionIdParam(raw: unknown): ParseResult<number> {
  const id = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN
  if (!Number.isSafeInteger(id) || id <= 0) return { ok: false, error: 'Invalid subscription id' }
  return { ok: true, value: id }
}
