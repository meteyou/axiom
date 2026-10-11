import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import {
  deleteOwnPushSubscription,
  deletePushSubscriptionByEndpoint,
  getPushPreviewEnabled,
  listPushSubscriptions,
  markPushSubscriptionDelivered,
  savePushSubscription,
  setPushPreviewEnabled,
} from './push-subscriptions.js'
import { purgeUserData } from './user-deletion.js'

const keys = { p256dh: 'BPk3', auth: 'c2VjcmV0' }

describe('push subscriptions', () => {
  let db: Database
  let dir: string
  const previous = process.env.DATA_DIR

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-push-subscriptions-'))
    process.env.DATA_DIR = dir
    db = initDatabase(':memory:')
    db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1, 'admin', 'h', 'admin'), (2, 'alice', 'h', 'user')").run()
  })

  afterEach(() => {
    if (previous === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previous
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('stores one row per device and lists only the owner\'s devices', () => {
    const phone = savePushSubscription(db, { userId: 2, endpoint: 'https://push.example/phone', keys, deviceLabel: 'Chrome on Android', locale: 'de' })
    savePushSubscription(db, { userId: 2, endpoint: 'https://push.example/laptop', keys })
    savePushSubscription(db, { userId: 1, endpoint: 'https://push.example/admin', keys })

    expect(phone).toMatchObject({ userId: 2, endpoint: 'https://push.example/phone', keys, deviceLabel: 'Chrome on Android', locale: 'de', lastSuccessAt: null })
    expect(listPushSubscriptions(db, 2).map(device => device.endpoint).sort()).toEqual(['https://push.example/laptop', 'https://push.example/phone'])
    expect(listPushSubscriptions(db, 1)).toHaveLength(1)
  })

  it('updates the existing row when the same device subscribes again', () => {
    const first = savePushSubscription(db, { userId: 2, endpoint: 'https://push.example/phone', keys })
    markPushSubscriptionDelivered(db, first.id)
    const again = savePushSubscription(db, { userId: 2, endpoint: 'https://push.example/phone', keys: { p256dh: 'new', auth: 'new' } })

    expect(again.id).toBe(first.id)
    expect(again.keys).toEqual({ p256dh: 'new', auth: 'new' })
    expect(again.lastSuccessAt).not.toBeNull()
    expect(listPushSubscriptions(db, 2)).toHaveLength(1)
  })

  it('moves a device to the user who subscribes it next, without the old delivery history', () => {
    const first = savePushSubscription(db, { userId: 1, endpoint: 'https://push.example/shared', keys })
    markPushSubscriptionDelivered(db, first.id)

    const moved = savePushSubscription(db, { userId: 2, endpoint: 'https://push.example/shared', keys })

    expect(moved.userId).toBe(2)
    expect(moved.lastSuccessAt).toBeNull()
    expect(listPushSubscriptions(db, 1)).toHaveLength(0)
  })

  it('never removes another user\'s device by id', () => {
    const aliceDevice = savePushSubscription(db, { userId: 2, endpoint: 'https://push.example/alice', keys })

    expect(deleteOwnPushSubscription(db, 1, aliceDevice.id)).toBe(false)
    expect(listPushSubscriptions(db, 2)).toHaveLength(1)
    expect(deleteOwnPushSubscription(db, 2, aliceDevice.id)).toBe(true)
    expect(listPushSubscriptions(db, 2)).toHaveLength(0)
  })

  it('removes a device by endpoint', () => {
    savePushSubscription(db, { userId: 2, endpoint: 'https://push.example/gone', keys })

    expect(deletePushSubscriptionByEndpoint(db, 'https://push.example/gone')).toBe(true)
    expect(deletePushSubscriptionByEndpoint(db, 'https://push.example/gone')).toBe(false)
  })

  it('keeps the message preview off until the user turns it on', () => {
    expect(getPushPreviewEnabled(db, 2)).toBe(false)
    setPushPreviewEnabled(db, 2, true)
    expect(getPushPreviewEnabled(db, 2)).toBe(true)
    expect(getPushPreviewEnabled(db, 1)).toBe(false)
  })

  it('drops the devices of a deleted user', () => {
    savePushSubscription(db, { userId: 2, endpoint: 'https://push.example/alice', keys })
    savePushSubscription(db, { userId: 1, endpoint: 'https://push.example/admin', keys })

    purgeUserData(db, 2)

    expect(listPushSubscriptions(db, 2)).toHaveLength(0)
    expect(listPushSubscriptions(db, 1)).toHaveLength(1)
  })

  it('cascades when a user row is removed outright', () => {
    savePushSubscription(db, { userId: 2, endpoint: 'https://push.example/alice', keys })

    db.prepare('DELETE FROM users WHERE id = 2').run()

    expect(listPushSubscriptions(db, 2)).toHaveLength(0)
  })
})
