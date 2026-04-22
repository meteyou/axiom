import { defineConfig } from 'vitepress'

// https://vitepress.dev/reference/site-config
export default defineConfig({
  title: 'Axiom',
  description: 'A personal AI agent you can shape into your own.',
  lang: 'en-US',
  cleanUrls: true,
  lastUpdated: true,

  // Allow http(s)://localhost:* links — they're examples for self-hosters,
  // not real links. Everything else is still validated.
  ignoreDeadLinks: [/^https?:\/\/localhost(:\d+)?(\/|$)/],

  head: [
    ['link', { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' }],
    ['meta', { name: 'theme-color', content: '#3b82f6' }],
  ],

  // Exclude internal/contributor docs from the user-facing site build.
  // `agent_docs/` lives at the repo root, not under `docs/`, so VitePress
  // already won't crawl it — this is just a defense-in-depth filter.
  srcExclude: ['**/README.md'],

  themeConfig: {
    // https://vitepress.dev/reference/default-theme-config
    logo: '/logo.svg',
    siteTitle: 'Axiom',

    nav: [
      { text: 'Guide', link: '/guide/quickstart', activeMatch: '/guide/' },
      { text: 'Reference', link: '/reference/env-vars', activeMatch: '/reference/' },
      {
        text: 'Links',
        items: [
          { text: 'GitHub', link: 'https://github.com/meteyou/axiom' },
          { text: 'Releases', link: 'https://github.com/meteyou/axiom/releases' },
        ],
      },
    ],

    sidebar: {
      '/guide/': [
        {
          text: 'Getting Started',
          items: [
            { text: 'Quickstart', link: '/guide/quickstart' },
            { text: 'Configuration', link: '/guide/configuration' },
            { text: 'LLM Providers', link: '/guide/providers' },
          ],
        },
        {
          text: 'Core Concepts',
          items: [
            { text: 'Memory System', link: '/guide/memory' },
            { text: 'Skills', link: '/guide/skills' },
            { text: 'Tasks & Cronjobs', link: '/guide/tasks-and-cronjobs' },
            { text: 'Built-in Tools', link: '/guide/tools' },
          ],
        },
        {
          text: 'Interfaces',
          items: [
            { text: 'Web UI', link: '/guide/web-ui' },
            { text: 'Telegram Bot', link: '/guide/telegram' },
          ],
        },
      ],
      '/reference/': [
        {
          text: 'Reference',
          items: [
            { text: 'Environment Variables', link: '/reference/env-vars' },
            { text: 'settings.json', link: '/reference/settings' },
            { text: 'File Paths', link: '/reference/file-paths' },
          ],
        },
      ],
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/meteyou/axiom' },
    ],

    footer: {
      message: 'Released under the MIT License.',
    },

    search: {
      provider: 'local',
    },

    editLink: {
      pattern: 'https://github.com/meteyou/axiom/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },
  },
})
