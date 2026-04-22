import { defineConfig, type DefaultTheme } from 'vitepress'

// Shared sidebar for /guide/ and /settings/ — Settings is a category inside the
// Guide nav, not a separate top-level nav entry.
const guideSidebar: DefaultTheme.SidebarItem[] = [
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
      { text: 'Agent Instructions', link: '/guide/instructions' },
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
  {
    text: 'Settings',
    items: [
      { text: 'Overview', link: '/settings/' },
      { text: 'Agent', link: '/settings/agent' },
      { text: 'Agent Heartbeat', link: '/settings/agent-heartbeat' },
      { text: 'Health Monitor', link: '/settings/health-monitor' },
      { text: 'Memory', link: '/settings/memory' },
      { text: 'Secrets', link: '/settings/secrets' },
      { text: 'Speech-to-Text', link: '/settings/speech-to-text' },
      { text: 'Tasks', link: '/settings/tasks' },
      { text: 'Telegram', link: '/settings/telegram' },
      { text: 'Text-to-Speech', link: '/settings/text-to-speech' },
    ],
  },
]

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
      { text: 'Guide', link: '/guide/quickstart', activeMatch: '/(guide|settings)/' },
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
      // Guide + Settings share the same sidebar so Settings appears as its own
      // category under the Guide nav entry (no separate top-level nav item).
      '/guide/': guideSidebar,
      '/settings/': guideSidebar,

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
