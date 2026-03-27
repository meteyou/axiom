// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-01-01',
  devtools: { enabled: true },
  ssr: false,

  modules: ['@nuxtjs/tailwindcss', '@nuxtjs/i18n'],

  tailwindcss: {
    configPath: '~/tailwind.config.ts',
    cssPath: '~/assets/css/tailwind.css',
    exposeConfig: false,
  },

  i18n: {
    locales: [
      { code: 'en', name: 'English', file: 'en.json' },
      { code: 'de', name: 'Deutsch', file: 'de.json' },
    ],
    defaultLocale: 'en',
    lazy: true,
    langDir: 'locales/',
    strategy: 'no_prefix',
    bundle: {
      optimizeTranslationDirective: false,
    },
  },

  runtimeConfig: {
    public: {
      apiBase: process.env.NUXT_PUBLIC_API_BASE || 'http://localhost:3000',
    },
  },

  devServer: {
    port: 3001,
  },

  routeRules: {
    '/api/**': {
      proxy: { to: 'http://localhost:3000/api/**' },
    },
    '/ws/**': {
      proxy: { to: 'http://localhost:3000/ws/**' },
    },
  },

  app: {
    head: {
      title: 'OpenAgent',
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
