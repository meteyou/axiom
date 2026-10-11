import { describe, expect, it } from 'vitest'
import { isTrustedPushEndpoint } from './push-endpoint.js'

describe('isTrustedPushEndpoint', () => {
  it.each([
    'https://fcm.googleapis.com/fcm/send/abc:def',
    'https://updates.push.services.mozilla.com/wpush/v2/gAAAA',
    'https://web.push.apple.com/QGuQyavXutnMH8',
    'https://wns2-par02p.notify.windows.com/w/?token=BQYAAA',
  ])('accepts the push service endpoint %s', (endpoint) => {
    expect(isTrustedPushEndpoint(endpoint)).toBe(true)
  })

  it.each([
    'http://fcm.googleapis.com/fcm/send/abc',
    'https://127.0.0.1/fcm/send/abc',
    'https://localhost/push',
    'https://10.0.0.5:8443/push',
    'https://internal.example/push',
    'https://fcm.googleapis.com.evil.example/fcm/send/abc',
    'https://evilfcm.googleapis.com.example/x',
    'https://notpush.apple.com.example/x',
    'https://fcm.googleapis.com:8443/fcm/send/abc',
    'https://user:pass@fcm.googleapis.com/fcm/send/abc',
    `https://fcm.googleapis.com/fcm/send/${'a'.repeat(2048)}`,
    'not a url',
    42,
    null,
  ])('rejects %s', (endpoint) => {
    expect(isTrustedPushEndpoint(endpoint)).toBe(false)
  })
})
