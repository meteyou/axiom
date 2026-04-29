---
layout: home

hero:
  name: Axiom
  text: Your personal agent
  tagline: There are many AI agents, but this one is yours.
  actions:
    - theme: brand
      text: Get Started
      link: /guide/quickstart
    - theme: alt
      text: View on GitHub
      link: https://github.com/meteyou/axiom

features:
  - title: Self-hosted, Docker-first
    details: One container, one volume, one command. No cloud lock-in. Your data stays with you.
    link: /guide/quickstart
    linkText: Quickstart
  - title: File-based memory
    details: SOUL, MEMORY, daily notes, user profiles, and a structured wiki — all plain Markdown the agent reads and writes.
    link: /concepts/memory
    linkText: Memory system
  - title: Skills you can extend
    details: Built-in skills auto-update from the image, your own skills are user-managed and persisted across upgrades.
    link: /concepts/skills
    linkText: How skills work
  - title: Background tasks & cronjobs
    details: Long-running jobs, scheduled work, and one-shot reminders — driven by the same agent that talks to you.
    link: /concepts/tasks-and-cronjobs
    linkText: Tasks & cronjobs
  - title: Multiple interfaces
    details: Web UI, Telegram bot, and a clean REST/WebSocket API. One agent, many entry points. More soon...
    link: /web-ui/
    linkText: Web Interface
  - title: Pluggable LLM providers
    details: Bring your own OpenAI-compatible provider, Anthropic, or local models via Ollama. Switch per task or cronjob.
    link: /web-ui/providers
    linkText: Configure providers
---

## Where to next?

<div class="vp-doc nav-matrix">

**New here?**
- [Quickstart](/guide/quickstart) — Docker setup in one command
- [Configuration](/guide/configuration) — admin user, encryption, env vars
- [Connect an LLM provider](/web-ui/providers) — OpenAI, Anthropic, Ollama, …

**Understand the agent**
- [System prompt](/concepts/system-prompt) — what the model sees every turn
- [Agent instructions](/concepts/instructions) — `AGENTS.md`, `CONSOLIDATION.md`, `HEARTBEAT.md`
- [Built-in tools](/concepts/tools) — what the agent can call out of the box

**Customize and extend**
- [Memory system](/concepts/memory) — SOUL, MEMORY, daily, wiki, sources
- [Skills](/concepts/skills) — built-in, user-installed, agent-created
- [Tasks & cronjobs](/concepts/tasks-and-cronjobs) — background work and scheduling

**Reference**
- [Environment variables](/reference/env-vars)
- [`settings.json` schema](/reference/settings)
- [Container file paths](/reference/file-paths)

</div>

---

Axiom is not just an AI agent platform. It is a foundation for building an agent that becomes truly your own through
customization, memory, workflow integration, and continued collaboration.

It combines a minimal core with practical interfaces like the web UI and Telegram, while leaving room for extension,
refinement, and personal shaping. The goal is not only to provide a capable assistant, but to enable an agent that can
adapt to one person's way of thinking, building, and working.

Over time, an agent should become more than a generic tool. It should become a reliable working partner. Shaped by use,
improved through iteration, and aligned with the needs of its user.

> Axiom is not only what it is built on. It is also what you make of it.
