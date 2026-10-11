import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { Database } from '@axiom/core'
import { initDatabase, listPushSubscriptions } from '@axiom/core'
import { createApp } from '../../../app.js'
import { generateAccessToken } from '../../../auth.js'
import { createPushNotifier } from '../../../push/push-notifier.js'
import type { SendPushFn } from '../../../push/push-notifier.js'

let db: Database
let server: http.Server
let baseUrl: string
let aliceId: number
let aliceToken: string
let bobToken: string
let tempDataDir: string
let previousDataDir: string | undefined
const send = vi.fn<SendPushFn>()

const keys = { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' }

function headers(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...extra }
}

async function subscribe(token: string, endpoint: string, extra: Record<string, unknown> = {}) {
  return fetch(`${baseUrl}/api/push/subscriptions`, {
    method: 'POST',
    headers: headers(token, { Origin: 'https://axiom.example.org', 'User-Agent': 'TestBrowser/1.0' }),
    body: JSON.stringify({ subscription: { endpoint, keys }, deviceLabel: 'Chrome on Android', locale: 'de', ...extra }),
  })
}

async function listDevices(token: string) {
  const res = await fetch(`${baseUrl}/api/push/subscriptions`, { headers: headers(token) })
  return { res, body: await res.json() as { devices: Array<{ id: number; endpoint: string; deviceLabel: string; userAgent: string }>; showPreview: boolean } }
}

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-push-route-'))
  process.env.DATA_DIR = tempDataDir

  db = initDatabase(':memory:')
  const notifier = createPushNotifier({
    db,
    loadKeys: () => ({ publicKey: 'test-public-key', privateKey: 'test-private-key', subject: null }),
    send,
  })
  server = http.createServer(createApp({ db, pushNotifier: notifier }))
  await new Promise<void>((resolve) => server.listen(0, resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`

  aliceId = Number(db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('alice', 'h', 'user')").run().lastInsertRowid)
  const bob = Number(db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('bob', 'h', 'user')").run().lastInsertRowid)
  aliceToken = generateAccessToken({ userId: aliceId, username: 'alice', role: 'user' })
  bobToken = generateAccessToken({ userId: bob, username: 'bob', role: 'user' })
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
  fs.rmSync(tempDataDir, { recursive: true, force: true })
})

beforeEach(() => {
  db.prepare('DELETE FROM push_subscriptions').run()
  send.mockReset()
  send.mockResolvedValue({ statusCode: 201 })
})

describe('push API', () => {
  it('requires authentication', async () => {
    for (const [method, url] of [
      ['GET', '/api/push/vapid-public-key'],
      ['GET', '/api/push/subscriptions'],
      ['POST', '/api/push/subscriptions'],
      ['DELETE', '/api/push/subscriptions/1'],
      ['POST', '/api/push/test'],
      ['PUT', '/api/push/preferences'],
    ] as const) {
      expect((await fetch(`${baseUrl}${url}`, { method })).status, `${method} ${url}`).toBe(401)
    }
  })

  it('serves the VAPID public key to any signed-in user', async () => {
    const res = await fetch(`${baseUrl}/api/push/vapid-public-key`, { headers: headers(aliceToken) })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ publicKey: 'test-public-key' })
  })

  it('subscribes a device and lists it for its owner only', async () => {
    const res = await subscribe(aliceToken, 'https://fcm.googleapis.com/fcm/send/alice-phone')
    expect(res.status).toBe(201)

    const alice = await listDevices(aliceToken)
    expect(alice.body.devices).toEqual([expect.objectContaining({
      endpoint: 'https://fcm.googleapis.com/fcm/send/alice-phone',
      deviceLabel: 'Chrome on Android',
      userAgent: 'TestBrowser/1.0',
    })])
    expect(alice.body.showPreview).toBe(false)
    expect((await listDevices(bobToken)).body.devices).toEqual([])

    const [stored] = listPushSubscriptions(db, aliceId)
    expect(stored).toMatchObject({ origin: 'https://axiom.example.org', locale: 'de' })
  })

  it('rejects malformed subscriptions', async () => {
    expect((await subscribe(aliceToken, 'http://fcm.googleapis.com/fcm/send/plain-http')).status).toBe(400)
    expect((await subscribe(aliceToken, 'not a url')).status).toBe(400)
    expect((await subscribe(aliceToken, 'https://10.0.0.5:8443/internal')).status).toBe(400)
    expect((await subscribe(aliceToken, 'https://fcm.googleapis.com.evil.example/fcm/send/x')).status).toBe(400)
    expect(listPushSubscriptions(db, aliceId)).toEqual([])
    const missingKeys = await fetch(`${baseUrl}/api/push/subscriptions`, {
      method: 'POST',
      headers: headers(aliceToken),
      body: JSON.stringify({ subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: 'a b', auth: '' } } }),
    })
    expect(missingKeys.status).toBe(400)
  })

  it('does not let a user remove someone else\'s device', async () => {
    await subscribe(aliceToken, 'https://fcm.googleapis.com/fcm/send/alice-phone')
    const [device] = (await listDevices(aliceToken)).body.devices

    const asBob = await fetch(`${baseUrl}/api/push/subscriptions/${device!.id}`, { method: 'DELETE', headers: headers(bobToken) })
    expect(asBob.status).toBe(404)
    expect((await listDevices(aliceToken)).body.devices).toHaveLength(1)

    const asAlice = await fetch(`${baseUrl}/api/push/subscriptions/${device!.id}`, { method: 'DELETE', headers: headers(aliceToken) })
    expect(asAlice.status).toBe(200)
    expect((await listDevices(aliceToken)).body.devices).toEqual([])
  })

  it('sends a test notification to the caller\'s devices only', async () => {
    await subscribe(aliceToken, 'https://fcm.googleapis.com/fcm/send/alice-phone')
    await subscribe(bobToken, 'https://fcm.googleapis.com/fcm/send/bob-phone')

    const res = await fetch(`${baseUrl}/api/push/test`, { method: 'POST', headers: headers(aliceToken) })

    expect(res.status).toBe(200)
    expect((await res.json() as { results: unknown[] }).results).toEqual([
      expect.objectContaining({ status: 'sent', deviceLabel: 'Chrome on Android', error: null }),
    ])
    expect(send).toHaveBeenCalledTimes(1)
    const [subscription, payload, options] = send.mock.calls[0]!
    expect(subscription.endpoint).toBe('https://fcm.googleapis.com/fcm/send/alice-phone')
    expect(JSON.parse(payload)).toMatchObject({ kind: 'test', title: 'Axiom', body: expect.stringContaining('Testbenachrichtigung') })
    expect(options.vapidDetails?.subject).toBe('https://axiom.example.org')
  })

  it('removes devices the push service reports as gone during a test', async () => {
    await subscribe(aliceToken, 'https://fcm.googleapis.com/fcm/send/expired')
    send.mockRejectedValue(Object.assign(new Error('Received unexpected response code'), { statusCode: 410 }))

    const res = await fetch(`${baseUrl}/api/push/test`, { method: 'POST', headers: headers(aliceToken) })

    expect((await res.json() as { results: Array<{ status: string }> }).results[0]!.status).toBe('removed')
    expect((await listDevices(aliceToken)).body.devices).toEqual([])
  })

  it('stores the preview preference per user', async () => {
    const res = await fetch(`${baseUrl}/api/push/preferences`, {
      method: 'PUT',
      headers: headers(aliceToken),
      body: JSON.stringify({ showPreview: true }),
    })

    expect(await res.json()).toEqual({ showPreview: true })
    expect((await listDevices(aliceToken)).body.showPreview).toBe(true)
    expect((await listDevices(bobToken)).body.showPreview).toBe(false)

    const invalid = await fetch(`${baseUrl}/api/push/preferences`, {
      method: 'PUT',
      headers: headers(aliceToken),
      body: JSON.stringify({ showPreview: 'yes' }),
    })
    expect(invalid.status).toBe(400)
  })
})
