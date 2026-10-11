// Axiom service worker: offline fallback, cache for hashed build assets, and Web Push.
//
// Deliberately small and hand-written. HTML, API and WebSocket traffic always
// go to the network, so a deploy can never leave a stale app shell behind:
// only content-hashed files under /_nuxt/ are cached, and those never change
// under the same URL.

const CACHE_VERSION = 'v1'
const SHELL_CACHE = `axiom-shell-${CACHE_VERSION}`
const ASSET_CACHE = `axiom-assets-${CACHE_VERSION}`
const OFFLINE_URL = '/offline.html'
const MAX_ASSET_ENTRIES = 300
// The Nuxt dev server serves unhashed modules under /_nuxt/; caching them would break HMR.
const DEV_MODE = new URL(self.location.href).searchParams.get('mode') === 'dev'

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await self.caches.open(SHELL_CACHE)
    await cache.add(new Request(OFFLINE_URL, { cache: 'reload' }))
    await self.skipWaiting()
  })())
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, ASSET_CACHE])
    const names = await self.caches.keys()
    await Promise.all(names.filter(name => name.startsWith('axiom-') && !keep.has(name)).map(name => self.caches.delete(name)))
    await self.clients.claim()
  })())
})

function isBypassed(url) {
  return url.origin !== self.location.origin
    || url.pathname.startsWith('/api/')
    || url.pathname.startsWith('/ws/')
    || url.pathname === '/health'
    || url.pathname === '/sw.js'
}

async function handleNavigation(request) {
  try {
    const response = await fetch(request)
    // A reverse proxy answers 502-504 while the backend is down; show the offline page then too.
    if (response.status >= 502 && response.status <= 504) {
      return (await self.caches.match(OFFLINE_URL)) ?? response
    }
    return response
  } catch (err) {
    const offline = await self.caches.match(OFFLINE_URL)
    if (offline) return offline
    throw err
  }
}

async function trimAssetCache(cache) {
  const keys = await cache.keys()
  const excess = keys.length - MAX_ASSET_ENTRIES
  for (let i = 0; i < excess; i++) await cache.delete(keys[i])
}

async function handleBuildAsset(request) {
  const cache = await self.caches.open(ASSET_CACHE)
  const cached = await cache.match(request)
  if (cached) return cached
  const response = await fetch(request)
  // The SPA fallback answers unknown paths with index.html; never store that under an asset URL.
  const contentType = response.headers.get('content-type') ?? ''
  if (response.ok && response.type === 'basic' && !contentType.includes('text/html')) {
    await cache.put(request, response.clone())
    await trimAssetCache(cache)
  }
  return response
}

self.addEventListener('fetch', (event) => {
  if (DEV_MODE) return
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (isBypassed(url)) return

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(request))
    return
  }
  if (url.pathname.startsWith('/_nuxt/')) {
    event.respondWith(handleBuildAsset(request))
  }
})

function readPushPayload(event) {
  if (!event.data) return {}
  try {
    return event.data.json()
  } catch {
    return { body: event.data.text() }
  }
}

// Every push must show a notification: Safari revokes subscriptions that push silently.
self.addEventListener('push', (event) => {
  const payload = readPushPayload(event)
  event.waitUntil(self.registration.showNotification(payload.title || 'Axiom', {
    body: payload.body || '',
    tag: payload.tag || 'axiom',
    renotify: true,
    data: { url: typeof payload.url === 'string' ? payload.url : '/' },
  }))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = new URL(event.notification.data?.url || '/', self.location.origin)
  if (target.origin !== self.location.origin) return

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const existing = windows.find(client => new URL(client.url).origin === self.location.origin)
    if (!existing) {
      await self.clients.openWindow(target.href)
      return
    }
    // Focus first: browsers only allow it while the click still counts as a user gesture.
    await existing.focus()
    existing.postMessage({ type: 'navigate', url: target.pathname + target.search })
  })())
})
