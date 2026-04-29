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

  app: {
    head: {
      title: 'Axiom',
      meta: [
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { name: 'description', content: 'Self-hosted AI Agent with Web Dashboard' },
      ],
      link: [
        {
          rel: 'stylesheet',
          href: 'https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&display=swap',
        },
      ],
    },
  },
})
