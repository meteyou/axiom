import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'

const rootPkg = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf-8'))

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2026-04-05',
  devtools: { enabled: true },
  ssr: false,

  modules: ['@nuxtjs/i18n'],

  components: [
    {
      path: '~/components',
      pathPrefix: false,
    },
  ],

  css: ['~/assets/css/tailwind.css'],

  i18n: {
    locales: [
      { code: 'en', name: 'English', file: 'en.json' },
      { code: 'de', name: 'Deutsch', file: 'de.json' },
    ],
    defaultLocale: 'en',
    langDir: 'locales',
    restructureDir: 'app/i18n',
    strategy: 'no_prefix',
  },

  vite: {
    plugins: [
      tailwindcss(),
    ],
    server: {
      fs: {
        // Allow serving files from the workspace root (monorepo hoisted node_modules)
        allow: ['../..'],
      },
    },
    optimizeDeps: {
      exclude: ['nuxt/dist/app/composables/manifest'],
    },
  },

  runtimeConfig: {
    public: {
      apiBase: process.env.NUXT_PUBLIC_API_BASE || '',
      appVersion: rootPkg.version || '0.0.0',
    },
  },

  devServer: {
    port: 3001,
  },

  // The backend builds the manifest from the logo setting. In dev the frontend
  // runs on its own port, but the manifest's start_url must be same-origin
  // with the page, so it is proxied instead of linked cross-origin.
  nitro: {
    devProxy: {
      '/site.webmanifest': {
        target: `${process.env.NUXT_PUBLIC_API_BASE || 'http://localhost:3000'}/site.webmanifest`,
        changeOrigin: true,
      },
    },
  },

  app: {
    head: {
      title: 'Axiom',
      meta: [
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { name: 'description', content: 'Self-hosted AI Agent with Web Dashboard' },
        { name: 'apple-mobile-web-app-title', content: 'Axiom' },
      ],
      link: [
        { rel: 'icon', href: '/favicon.ico', sizes: '48x48' },
        { key: 'favicon-svg', rel: 'icon', type: 'image/svg+xml', href: '/logos/prism.svg' },
        { key: 'apple-touch-icon', rel: 'apple-touch-icon', href: '/apple-touch-icon.png' },
        { rel: 'manifest', href: '/site.webmanifest' },
        {
          rel: 'stylesheet',
          href: 'https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&display=swap',
        },
      ],
    },
  },
})
