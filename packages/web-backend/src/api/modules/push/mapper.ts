import type { PushSubscriptionRecord } from '@axiom/core'
import type { PushDeliveryResult } from '../../../push/push-notifier.js'

const MAX_ERROR_LENGTH = 300

export function mapPushDevice(record: PushSubscriptionRecord) {
  return {
    id: record.id,
    endpoint: record.endpoint,
    deviceLabel: record.deviceLabel,
    userAgent: record.userAgent,
    createdAt: record.createdAt,
    lastSuccessAt: record.lastSuccessAt,
  }
}

export function mapPushDeliveryResult(result: PushDeliveryResult) {
  return {
    subscriptionId: result.subscriptionId,
    deviceLabel: result.deviceLabel,
    status: result.status,
    statusCode: result.statusCode ?? null,
    error: result.error ? result.error.slice(0, MAX_ERROR_LENGTH) : null,
  }
}
