import { describe, expect, it } from 'vitest'
import { describeDevice, detectPushSupport, matchesServerKey, serviceWorkerUrl, urlBase64ToUint8Array } from './pushSupport'
import type { PushEnvironment } from './pushSupport'

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1'
const IPAD_DESKTOP_MODE = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15'
const ANDROID_CHROME = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36'
const WINDOWS_EDGE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0'
const LINUX_FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0'

function env(overrides: Partial<PushEnvironment> = {}): PushEnvironment {
  return {
    isSecureContext: true,
    hasServiceWorker: true,
    hasPushManager: true,
    hasNotification: true,
    userAgent: ANDROID_CHROME,
    maxTouchPoints: 5,
    standalone: false,
    ...overrides,
  }
}

describe('detectPushSupport', () => {
  it('supports Android browsers without installing the app', () => {
    expect(detectPushSupport(env())).toBe('supported')
  })

  it('requires a secure context first', () => {
    expect(detectPushSupport(env({ isSecureContext: false, hasServiceWorker: false }))).toBe('insecure-context')
  })

  it('asks iPhone users to add the app to the home screen', () => {
    expect(detectPushSupport(env({ userAgent: IPHONE, hasPushManager: false }))).toBe('ios-needs-install')
    expect(detectPushSupport(env({ userAgent: IPHONE, standalone: true }))).toBe('supported')
  })

  it('recognizes an iPad that reports itself as a Mac', () => {
    expect(detectPushSupport(env({ userAgent: IPAD_DESKTOP_MODE, maxTouchPoints: 5 }))).toBe('ios-needs-install')
    expect(detectPushSupport(env({ userAgent: IPAD_DESKTOP_MODE, maxTouchPoints: 0 }))).toBe('supported')
  })

  it('reports installed iOS apps without the Push API (before iOS 16.4) as unsupported', () => {
    expect(detectPushSupport(env({ userAgent: IPHONE, standalone: true, hasPushManager: false }))).toBe('unsupported')
  })
})

describe('describeDevice', () => {
  it('names browser and system', () => {
    expect(describeDevice(ANDROID_CHROME)).toBe('Chrome on Android')
    expect(describeDevice(WINDOWS_EDGE)).toBe('Edge on Windows')
    expect(describeDevice(LINUX_FIREFOX)).toBe('Firefox on Linux')
    expect(describeDevice(IPHONE)).toBe('Safari on iPhone')
  })

  it('names installed apps by their system', () => {
    expect(describeDevice(IPHONE, true)).toBe('iPhone app')
  })

  it('falls back to a generic label', () => {
    expect(describeDevice('curl/8.0')).toBe('Browser')
  })
})

describe('VAPID key helpers', () => {
  const key = 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM'

  it('decodes base64url keys', () => {
    const bytes = urlBase64ToUint8Array(key)
    expect(bytes).toHaveLength(65)
    expect(bytes[0]).toBe(0x04)
  })

  it('detects whether a subscription was made with the current key', () => {
    expect(matchesServerKey(urlBase64ToUint8Array(key).buffer, key)).toBe(true)
    expect(matchesServerKey(urlBase64ToUint8Array(key).buffer, key.replace('BNc', 'BNd'))).toBe(false)
    expect(matchesServerKey(null, key)).toBe(false)
  })
})

describe('serviceWorkerUrl', () => {
  it('turns caching off in dev mode', () => {
    expect(serviceWorkerUrl(true)).toBe('/sw.js?mode=dev')
    expect(serviceWorkerUrl(false)).toBe('/sw.js')
  })
})
