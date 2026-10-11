# Settings

Tune how the agent behaves, how long sessions live, which provider answers, and how Telegram messages are handled.

All settings described in this section live in the web UI under **Settings**, and are persisted to `/data/config/settings.json`. You can edit either — the UI is the supported path, the file is documented for power users and for the agent itself to reason about.

> **Admin only, except personal settings.** Only users with role `admin` can see and change the settings described in this section. Regular users get the **Agent** tab, where they set their own chat model, thinking level, language and timezone — see [Agent → Personal agent settings](./agent#personal-agent-settings-regular-users) — plus the **Heartbeat** tab for their own heartbeat, the **Email** tab for their own mail accounts — see [Email](./email) — the **Notifications** tab for push notifications on their own devices — see [App & Push Notifications](../guide/push-notifications) — and the **Secrets** tab for personal secrets that override global ones of the same name — see [Secrets](./secrets).

## The Settings Subpages

The Settings page has one sidebar entry per concern. Each gets its own docs page here:

| Panel                                | What it controls                                                                        |
|--------------------------------------|-----------------------------------------------------------------------------------------|
| [Agent](./agent)                     | Language, timezone, active provider + model, reasoning level, codemode (experimental), upload retention, resilience, context compaction, `AGENTS.md` rules. |
| [Agent Heartbeat](./agent-heartbeat) | Whether (and when) the agent runs recurring self-driven tasks from `HEARTBEAT.md`.      |
| [Appearance](./appearance)           | Logo of the web UI (sidebar, login page, chat avatar, favicon).                         |
| [Email](./email)                     | Your own IMAP/SMTP accounts for the agent, send rules, approvals and the sent log.      |
| [Health Monitor](./health-monitor)   | Provider health checks, automatic fallback, notification toggles.                       |
| [Image Generation](./image-generation) | Switch for `generate_image`, default image model, variant limit, output folder. |
| [Memory](./memory)                   | Session timeout, memory consolidation, fact extraction.                                 |
| [Notifications](../guide/push-notifications#enable-notifications) | Push notifications for finished chat replies on your own devices (every user, not only admins). |
| [Secrets](./secrets)                 | API keys and other sensitive values stored in `/data/config/secrets.json`.              |
| [Speech-to-Text](./speech-to-text)   | Transcription provider (OpenAI, Whisper URL, Ollama) and optional LLM rewrite.          |
| [Tasks](./tasks)                     | Default task provider, max duration, loop detection, status updates, Telegram delivery, codemode (experimental). |
| [Telegram](./telegram)               | Bot token, message batching, user approval + assignment.                                |
| [Text-to-Speech](./text-to-speech)   | Voice output provider (OpenAI, Mistral/Voxtral), voice, audio format.                   |

## Saving changes

Every panel except **Secrets**, **Email** and **Notifications** uses the same **Save** button in the page header. Changes take effect on the next agent turn — no restart needed. Secrets have their own per-row save/delete flow because they are write-only from the UI's perspective (existing values are masked, never returned in full).

## Where values live

| Kind                            | File                            | Edited by                             |
|---------------------------------|---------------------------------|---------------------------------------|
| Non-secret runtime settings     | `/data/config/settings.json`    | UI (all panels except Secrets)        |
| API keys, tokens, other secrets | `/data/config/secrets.json`     | UI (Secrets panel)                    |
| Behavior rules for the agent    | `/data/config/AGENTS.md`        | UI (Instructions page) or direct edit |
| Recurring self-tasks            | `/data/config/HEARTBEAT.md`     | UI (Instructions page) or direct edit |
| Consolidation rules             | `/data/config/CONSOLIDATION.md` | UI (Instructions page) or direct edit |

See [File Paths](../reference/file-paths) for the full volume layout and [`settings.json` Reference](../reference/settings) for the raw schema.
