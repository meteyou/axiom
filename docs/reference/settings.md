# `settings.json` Reference

> **This page is a stub.** Full content will be written together with the agent.

`/data/config/settings.json` holds all non-secret runtime configuration. The web UI's **Settings** page is the supported way to edit it, but the file format is documented here for power users and for the agent itself to reason about.

Top-level keys (defaults shown — see `packages/core/src/config.ts` for the full template):

| Key | Type | Purpose |
|---|---|---|
| `sessionTimeoutMinutes` | `number` (30) | Inactivity timeout before a session is marked "ended". |
| `sessionSummaryProviderId` | `string` ("") | Provider used to summarize ended sessions. Empty = no summary. |
| `language` | `string` (`"en"`) | Forced response language, or `"match"` to mirror the user. |
| `timezone` | `string` (`"UTC"`) | Used for cron evaluation and daily-memory file naming. Mirrors `TZ` if set. |
| `thinkingLevel` | `"off" \| "low" \| "medium" \| "high"` | Default reasoning level for chat. |
| `heartbeat` | object | Provider health checks (interval, fallback triggers, notifications). |
| `agentHeartbeat` | object | Agent self-driven recurring tasks (see `HEARTBEAT.md`). |
| `memoryConsolidation` | object | See [Memory System → Consolidation](../guide/memory#memory-consolidation-optional). |
| `factExtraction` | object | See [Memory System → Fact Extraction](../guide/memory#fact-extraction-optional). |
| `builtinTools` | object | Per-tool enabled flags + provider choice (web search, web fetch, stt). |
| `tasks` | object | Defaults for task execution: provider, max duration, loop detection, status updates, telegram delivery. |
| `tokenPriceTable` | object | Per-model `{ input, output }` cost in USD per 1M tokens. Used by the **Usage** page. |
| `batchingDelayMs` | `number` (2500) | Web chat: how long to wait before flushing a batched user message to the agent. |
| `uploads.retentionDays` | `number` (30) | How long to keep uploaded files in `/data/uploads/`. `0` deletes them on the next cleanup run. |

---

*To be expanded: full type signature for every nested object, validation rules, migration notes, examples for typical setups (single user, multi user, telegram-heavy, fully autonomous).*
