# Web UI

> **This page is a stub.** Full content will be written together with the agent.

The web UI is a Nuxt 3 single-page app served by the backend on port `3000`. Top-level pages:

- **Chat** — the main agent conversation view.
- **Tasks** — list/create/inspect background tasks and cronjobs; view live logs.
- **Memory** — inline editors for `SOUL.md`, `MEMORY.md`, `AGENTS.md`, plus daily/user/wiki file browsers. See [Memory System](./memory).
- **Settings** — providers, secrets, scheduler, tools, telegram, memory consolidation, fact extraction, heartbeat.
- **Sessions** — browse past sessions across all sources (web, telegram, task).
- **Usage** — token usage and cost rollups using the `tokenPriceTable` from settings.

---

*To be expanded: page-by-page screenshots, keyboard shortcuts, the multi-user model, the streaming chat behavior, file uploads, session-summary UX.*
