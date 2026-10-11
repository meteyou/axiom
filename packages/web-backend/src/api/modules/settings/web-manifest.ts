import type { AppLogo } from '@axiom/core'

export const WEB_MANIFEST_PATH = '/site.webmanifest'

const THEME_COLOR = '#0C8D62'
// Dark UI background, hsl(228 22% 12%), so the splash screen matches the app shell.
const BACKGROUND_COLOR = '#181B25'

export function buildWebManifest(logo: AppLogo) {
  return {
    id: '/',
    name: 'Axiom',
    short_name: 'Axiom',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    theme_color: THEME_COLOR,
    background_color: BACKGROUND_COLOR,
    icons: [
      { src: `/icons/${logo}-192.png`, sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: `/icons/${logo}-512.png`, sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: `/icons/${logo}-maskable-512.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}
