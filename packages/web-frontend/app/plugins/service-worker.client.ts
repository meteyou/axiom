import { serviceWorkerUrl } from '~/utils/pushSupport'

export default defineNuxtPlugin(() => {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return

  navigator.serviceWorker.addEventListener('message', (event: MessageEvent<{ type?: string; url?: unknown }>) => {
    if (event.data?.type === 'navigate' && typeof event.data.url === 'string' && event.data.url.startsWith('/')) {
      void navigateTo(event.data.url)
    }
  })

  const register = () => {
    navigator.serviceWorker
      .register(serviceWorkerUrl(import.meta.dev), { scope: '/' })
      .catch(err => console.warn('[sw] Service worker registration failed:', err))
  }
  if (document.readyState === 'complete') register()
  else window.addEventListener('load', register, { once: true })
})
