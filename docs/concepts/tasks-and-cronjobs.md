# Tasks & Cronjobs

> **This page is a stub.** Full content will be written together with the agent.

Axiom supports three flavors of agent-driven background work:

- **Tasks** — fire-and-forget background runs. The agent (or you) calls `create_task` with a prompt; a worker spins up, runs, optionally pauses for a follow-up message (`resume_task`), and reports back when done.
- **Cronjobs** — recurring scheduled tasks. Standard 5-field cron expressions, evaluated in the configured `TZ`. Edit/list/get/remove from the UI or via tools.
- **Reminders** — one-shot scheduled messages delivered at a specific time, via Telegram or the web UI.

Configure defaults (provider, max duration, loop detection, telegram delivery) in the web UI under **Settings → Tasks** or directly in `settings.json` under the `tasks` key.

---

*To be expanded: state machine (queued → running → paused → done), loop-detection (systematic vs. smart), telegram-delivery rules, status-update intervals, background thinking levels, examples for common cronjob patterns.*
