import { defineConfig, type DefaultTheme } from 'vitepress'

// Shared sidebar for /guide/, /concepts/, /web-ui/ and /settings/ —
// Concepts, Web Interface and Settings are categories inside the Guide
// nav, not separate top-level nav entries.
const guideSidebar: DefaultTheme.SidebarItem[] = [
  {
    text: 'Getting Started',
    items: [
      { text: 'Quickstart', link: '/guide/quickstart' },
      { text: 'Configuration', link: '/guide/configuration' },
      { text: 'Telegram Bot', link: '/guide/telegram' },
    ],
  },
  {
    text: 'Core Concepts',
    items: [
      { text: 'Overview', link: '/concepts/' },
      { text: 'Agent Instructions', link: '/concepts/instructions' },
      { text: 'Built-in Tools', link: '/concepts/tools' },
      { text: 'Memory System', link: '/concepts/memory' },
      { text: 'Skills', link: '/concepts/skills' },
      { text: 'System Prompt', link: '/concepts/system-prompt' },
      { text: 'Tasks & Cronjobs', link: '/concepts/tasks-and-cronjobs' },
    ],
  },
  {
    text: 'Web Interface',
    items: [
      { text: 'Overview', link: '/web-ui/' },
      { text: 'Dashboard', link: '/web-ui/dashboard' },
      { text: 'Chat', link: '/web-ui/chat' },
      { text: 'Tasks', link: '/web-ui/tasks' },
      { text: 'Cronjobs', link: '/web-ui/cronjobs' },
      { text: 'Memory', link: '/web-ui/memory' },
      { text: 'Activity Logs', link: '/web-ui/activity-logs' },
      { text: 'Token Usage', link: '/web-ui/token-usage' },
      { text: 'Users', link: '/web-ui/users' },
      { text: 'Providers', link: '/web-ui/providers' },
      { text: 'Skills', link: '/web-ui/skills' },
      { text: 'Instructions', link: '/web-ui/instructions' },
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
  title: 'Axiom Documentation',
  description: 'Your personal AI agent you can shape into your own.',
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

  markdown: {
    config(md) {
      // Render `[title]` after the language identifier on standalone code
      // blocks as a label above the block. VitePress' built-in [title]
      // syntax only applies inside `::: code-group`; this extends it to
      // every fenced code block so we don't have to wrap single blocks.
      const defaultFence = md.renderer.rules.fence!
      md.renderer.rules.fence = (tokens, idx, options, env, self) => {
        const token = tokens[idx]
        const info = token.info || ''
        const match = info.match(/\[(.+?)\]/)
        const html = defaultFence(tokens, idx, options, env, self)
        if (!match) return html
        const title = md.utils.escapeHtml(match[1])
        return `<div class="vp-code-block-title">${title}</div>${html}`
      }
    },
  },

  themeConfig: {
    // https://vitepress.dev/reference/default-theme-config
    logo: '/logo.svg',
    siteTitle: 'Axiom',

    nav: [
      { text: 'Guide', link: '/guide/quickstart', activeMatch: '/(guide|concepts|web-ui|settings)/' },
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
      '/guide/': guideSidebar,
      '/concepts/': guideSidebar,
      '/web-ui/': guideSidebar,
      '/settings/': guideSidebar,

      '/reference/': [
        {
          text: 'Reference',
          items: [
            { text: 'Environment Variables', link: '/reference/env-vars' },
            { text: 'Configuration Files', link: '/reference/settings' },
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
