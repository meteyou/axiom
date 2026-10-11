import { beforeEach, describe, expect, it, vi } from 'vitest'
import { initDatabase, listPushSubscriptions, savePushSubscription } from '@axiom/core'
import type { Database } from '@axiom/core'
import { createPushNotifier, resolveVapidSubject } from './push-notifier.js'
import type { PushNotificationPayload, SendPushFn } from './push-notifier.js'

const keys = { p256dh: 'BPk3', auth: 'c2VjcmV0' }
const vapid = { publicKey: 'public', privateKey: 'private', subject: null }
const payload: PushNotificationPayload = { kind: 'test', title: 'Axiom', body: 'Hi', url: '/', tag: 'axiom-test' }

function pushError(statusCode: number): Error {
  return Object.assign(new Error('Received unexpected response code'), { statusCode, body: `status ${statusCode}` })
}

describe('createPushNotifier', () => {
  let db: Database

  beforeEach(() => {
    db = initDatabase(':memory:')
    db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1, 'admin', 'h', 'admin'), (2, 'alice', 'h', 'user')").run()
  })

  it('sends the payload to every device of the user and records the delivery', async () => {
    savePushSubscription(db, { userId: 2, endpoint: 'https://push.example/a', keys, origin: 'https://axiom.example.org' })
    savePushSubscription(db, { userId: 2, endpoint: 'https://push.example/b', keys })
    savePushSubscription(db, { userId: 1, endpoint: 'https://push.example/admin', keys })
    const send = vi.fn<SendPushFn>(async () => ({ statusCode: 201 }))
    const notifier = createPushNotifier({ db, loadKeys: () => vapid, send })

    const results = await notifier.sendToUser(2, () => payload)

    expect(results.map(result => result.status)).toEqual(['sent', 'sent'])
    expect(send).toHaveBeenCalledTimes(2)
    const endpoints = send.mock.calls.map(([subscription]) => subscription.endpoint).sort()
    expect(endpoints).toEqual(['https://push.example/a', 'https://push.example/b'])
    const callForA = send.mock.calls.find(([subscription]) => subscription.endpoint === 'https://push.example/a')!
    expect(JSON.parse(callForA[1])).toEqual(payload)
    expect(callForA[2].vapidDetails).toEqual({ subject: 'https://axiom.example.org', publicKey: 'public', privateKey: 'private' })
    expect(listPushSubscriptions(db, 2).every(device => device.lastSuccessAt !== null)).toBe(true)
  })

  it.each([404, 410])('removes a subscription the push service reports as gone (%i)', async (statusCode) => {
    savePushSubscription(db, { userId: 2, endpoint: 'https://push.example/gone', keys })
    savePushSubscription(db, { userId: 2, endpoint: 'https://push.example/alive', keys })
    const send = vi.fn<SendPushFn>(async (subscription) => {
      if (subscription.endpoint.endsWith('/gone')) throw pushError(statusCode)
      return { statusCode: 201 }
    })
    const notifier = createPushNotifier({ db, loadKeys: () => vapid, send })

    const results = await notifier.sendToUser(2, () => payload)

    expect(results.find(result => result.status === 'removed')).toMatchObject({ statusCode })
    expect(listPushSubscriptions(db, 2).map(device => device.endpoint)).toEqual(['https://push.example/alive'])
  })

  it('keeps a subscription on other failures and reports the error', async () => {
    savePushSubscription(db, { userId: 2, endpoint: 'https://push.example/flaky', keys, deviceLabel: 'Safari on iPhone' })
    const logger = { warn: vi.fn() }
    const notifier = createPushNotifier({ db, loadKeys: () => vapid, send: async () => { throw pushError(403) }, logger })

    const [result] = await notifier.sendToUser(2, () => payload)

    expect(result).toMatchObject({ status: 'failed', statusCode: 403, deviceLabel: 'Safari on iPhone' })
    expect(result!.error).toContain('status 403')
    expect(listPushSubscriptions(db, 2)).toHaveLength(1)
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('builds the payload per device', async () => {
    savePushSubscription(db, { userId: 2, endpoint: 'https://push.example/de', keys, locale: 'de' })
    const send = vi.fn<SendPushFn>(async () => ({ statusCode: 201 }))
    const notifier = createPushNotifier({ db, loadKeys: () => vapid, send })

    await notifier.sendToUser(2, device => ({ ...payload, body: device.locale ?? 'none' }))

    expect(JSON.parse(send.mock.calls[0]![1]).body).toBe('de')
  })

  it('does not load keys when the user has no devices', async () => {
    const loadKeys = vi.fn(() => vapid)
    const notifier = createPushNotifier({ db, loadKeys, send: vi.fn<SendPushFn>() })

    expect(await notifier.sendToUser(2, () => payload)).toEqual([])
    expect(loadKeys).not.toHaveBeenCalled()
  })
})

describe('resolveVapidSubject', () => {
  it('prefers the configured subject', () => {
    expect(resolveVapidSubject('mailto:ops@example.org', 'https://axiom.example.org')).toBe('mailto:ops@example.org')
  })

  it('uses the public HTTPS origin the device subscribed from', () => {
    expect(resolveVapidSubject(null, 'https://axiom.example.org')).toBe('https://axiom.example.org')
  })

  it('falls back to a mailto subject for origins Apple would reject', () => {
    expect(resolveVapidSubject(null, 'http://192.168.1.5:3000')).toMatch(/^mailto:/)
    expect(resolveVapidSubject(null, 'https://localhost:3000')).toMatch(/^mailto:/)
    expect(resolveVapidSubject(null, null)).toMatch(/^mailto:/)
    expect(resolveVapidSubject(null, 'not a url')).toMatch(/^mailto:/)
  })
})
