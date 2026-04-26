# Built-in Tools

> **This page is a stub.** Full content will be written together with the agent.

The agent always has the four core tools (`shell`, `read_file`, `write_file`, `edit_file`, `list_files`). On top of those, several built-in tools can be enabled or disabled in **Settings → Tools** (`builtinTools` in `settings.json`):

| Tool | Default | Notes |
|---|---|---|
| `web_search` | enabled (DuckDuckGo) | Switch backend to Brave or SearxNG in settings. Brave needs `braveSearchApiKey`, SearxNG needs `searxngUrl`. |
| `web_fetch` | enabled | Fetches a URL and extracts readable text. Pair with `web_search`. |
| `transcribe_audio` | disabled | Calls a Whisper-compatible STT endpoint. Bring your own server (local `faster-whisper-server` example commented in the Compose file). |
| `read_chat_history` | always on | Full-text search over past sessions with source/role/date filters. |
| `search_memories` | always on | Searches the fact memory built up by [fact extraction](./memory#fact-extraction-optional). |

Plus the task/cronjob/reminder tools listed under [Tasks & Cronjobs](./tasks-and-cronjobs).

---

*To be expanded: per-tool input/output schemas, tuning knobs, when each backend is the right choice, custom tool authoring (if/when that becomes a thing).*
