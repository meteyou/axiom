const MAX_ENDPOINT_LENGTH = 2048

/**
 * The server POSTs to whatever endpoint a user registers, so only the browser
 * vendors' push services may be reachable — any other host would let a user
 * make the server call internal services (SSRF).
 */
const PUSH_SERVICE_DOMAINS = [
  'fcm.googleapis.com',
  'push.services.mozilla.com',
  'push.apple.com',
  'notify.windows.com',
]

function isPushServiceHost(hostname: string): boolean {
  return PUSH_SERVICE_DOMAINS.some(domain => hostname === domain || hostname.endsWith(`.${domain}`))
}

export function isTrustedPushEndpoint(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MAX_ENDPOINT_LENGTH) return false
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  return url.protocol === 'https:'
    && url.port === ''
    && url.username === ''
    && url.password === ''
    && isPushServiceHost(url.hostname)
}
