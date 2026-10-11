/** Must match the tag the backend puts on chat reply notifications. */
export const CHAT_NOTIFICATION_TAG = 'axiom-chat'

export function serviceWorkerUrl(dev: boolean): string {
  return dev ? '/sw.js?mode=dev' : '/sw.js'
}

export type PushSupport = 'supported' | 'insecure-context' | 'ios-needs-install' | 'unsupported'

export interface PushEnvironment {
  isSecureContext: boolean
  hasServiceWorker: boolean
  hasPushManager: boolean
  hasNotification: boolean
  userAgent: string
  maxTouchPoints: number
  /** Running as an installed home-screen app (`display-mode: standalone`). */
  standalone: boolean
}

function isIos(userAgent: string, maxTouchPoints: number): boolean {
  // iPadOS reports itself as macOS; the touch screen gives it away.
  return /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1)
}

/**
 * iOS only exposes Web Push to web apps added to the home screen (iOS 16.4+),
 * so Safari in a tab gets an install hint instead of a generic "unsupported".
 */
export function detectPushSupport(env: PushEnvironment): PushSupport {
  if (!env.isSecureContext) return 'insecure-context'
  if (isIos(env.userAgent, env.maxTouchPoints) && !env.standalone) return 'ios-needs-install'
  if (!env.hasServiceWorker || !env.hasPushManager || !env.hasNotification) return 'unsupported'
  return 'supported'
}

export function readPushEnvironment(): PushEnvironment {
  return {
    isSecureContext: window.isSecureContext,
    hasServiceWorker: 'serviceWorker' in navigator,
    hasPushManager: 'PushManager' in window,
    hasNotification: 'Notification' in window,
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
    standalone: window.matchMedia('(display-mode: standalone)').matches
      || (navigator as Navigator & { standalone?: boolean }).standalone === true,
  }
}

const BROWSERS: Array<[RegExp, string]> = [
  [/Edg\//, 'Edge'],
  [/OPR\/|Opera/, 'Opera'],
  [/SamsungBrowser/, 'Samsung Internet'],
  [/Firefox\/|FxiOS/, 'Firefox'],
  [/Chrome\/|CriOS/, 'Chrome'],
  [/Safari\//, 'Safari'],
]

const SYSTEMS: Array<[RegExp, string]> = [
  [/iPhone/, 'iPhone'],
  [/iPad/, 'iPad'],
  [/Android/, 'Android'],
  [/Windows/, 'Windows'],
  [/CrOS/, 'ChromeOS'],
  [/Macintosh|Mac OS X/, 'macOS'],
  [/Linux/, 'Linux'],
]

/** Short human label such as "Chrome on Android", stored with the subscription. */
export function describeDevice(userAgent: string, standalone = false): string {
  const browser = BROWSERS.find(([pattern]) => pattern.test(userAgent))?.[1]
  const system = SYSTEMS.find(([pattern]) => pattern.test(userAgent))?.[1]
  const base = standalone && system ? `${system} app` : [browser, system].filter(Boolean).join(' on ')
  return base || 'Browser'
}

export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(padded)
  const bytes = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes
}

/** Whether an existing browser subscription was made with the server's current VAPID key. */
export function matchesServerKey(applicationServerKey: ArrayBuffer | null, publicKey: string): boolean {
  if (!applicationServerKey) return false
  const current = new Uint8Array(applicationServerKey)
  const expected = urlBase64ToUint8Array(publicKey)
  return current.length === expected.length && current.every((byte, i) => byte === expected[i])
}

/** Closes chat notifications that are already on screen, e.g. once the chat is open again. */
export async function closeChatNotifications(): Promise<void> {
  if (!('serviceWorker' in navigator)) return
  const registration = await navigator.serviceWorker.getRegistration()
  const notifications = await registration?.getNotifications({ tag: CHAT_NOTIFICATION_TAG }) ?? []
  for (const notification of notifications) notification.close()
}
