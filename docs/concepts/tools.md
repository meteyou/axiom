# Built-in Tools

With every request the agent receives a tool registry — the concrete list of functions it can call. Most tools are **always on** because they're load-bearing for how Axiom works (memory, files, chat history, background tasks). A few are **opt-in** because they need an external service or a key.

The list below is what the agent gets as tool definitions. There is no separate tool overview in the [system prompt](./system-prompt): usage hints live in each tool's description, so they can't drift from the actual tool set. When you toggle a tool off in the UI, it disappears from the registry.

The tool list is built once per session, together with the system prompt. Toggling a tool, codemode or image generation applies from the next session — run `/new` to pick it up right away. See [System Prompt → Built once per session](./system-prompt#built-once-per-session).

Tool names follow an `area_verb` pattern (`file_read`, `task_write`, `schedule_read`, …). Closely related operations are grouped into one tool with an `action` parameter — for example `task_write` with `action: "create" | "resume" | "stop"`. A call with a missing field gets a precise error back (*"schedule is required for action=create"*), so the agent can correct itself in the next step. See [Renamed tools](#renamed-tools) for the mapping from the old names.

## Filesystem & shell

These are the agent's hands. They run inside the workspace dir (`/workspace` in Docker) and are unrestricted — there is no allow-list, no per-command confirmation. Treat the agent as a non-root shell user.

| Tool | Notes |
|---|---|
| `shell` | Execute a shell command and return stdout/stderr. Honors `cwd = /workspace` and a 60s default timeout. Use `sudo` for privileged ops (`apt-get install`, `systemctl`, …). |
| `file_read` | Read a file by path. Text output is capped at 2000 lines or 50 KB per call; `offset` / `limit` page through longer files. Images (PNG, JPEG, GIF, WebP, TIFF, AVIF; not HEIC) are attached so a vision-capable model can see them, rotated and downscaled the same way as [chat uploads](../web-ui/chat#attachments). Other binary files are not dumped as text. Has special handling for `SKILL.md` files under `/data/skills/` and `/data/skills_agent/` — auto-injects `{baseDir}` and tracks usage. |
| `file_write` | Overwrite or create a file (creates parent dirs). Prefer `file_edit` for surgical changes — it diffs cleanly in the UI and is harder to misuse. |
| `file_edit` | Exact-text replacement: `{oldText, newText}` pairs. `oldText` must be unique and present in the file. Preferred over `file_write` for surgical changes. |
| `file_list` | List a directory's entries with a `[dir]` / `[file]` prefix. |

## Memory & history

The agent's read-side into its own past. These tools are what make the [Memory System](./memory) actually queryable instead of just static files in the prompt.

| Tool | Notes |
|---|---|
| `chat_history_read` | Full-text search over past chat messages with filters for datetime range, source (`web` / `telegram` / `task`), role (`user` / `assistant` / `tool` / `system`), and session id. Pagination via `limit` (default 100, max 500) and `offset`. |
| `memory_search` | One search over past knowledge: the atomic facts produced by [fact extraction](./memory#fact-extraction) (up to 50 per query) and the [wiki](./memory#wiki-wiki-md) full-text index (up to 10 pages, each with path, title, aliases and snippet). The agent opens a wiki hit with `file_read`. |
| `skill_list` | Browse every self-created skill under `/data/skills_agent/` with its description, location, last-used date, and any missing required env vars. The 10 most recent are already injected into the prompt; this tool reaches the rest. See [Skills](./skills). |

## Tasks, cronjobs & reminders

The agent can spawn its own background workers and schedule recurring or one-shot work without touching the host's `cron`. The schedule tools are chat only — background tasks don't get them. Defaults (provider, max duration, loop detection, telegram delivery) live under [Settings → Tasks](../settings/tasks).

| Tool | Notes |
|---|---|
| `task_read` | List your background tasks with status, trigger and limit filters. Admins also see other users' tasks, but only title, owner and status. |
| `task_write` | `action: "create"` spawns a background agent with a self-contained prompt — optional `provider` / `model` to pin a specific runtime, `thinking_level` for the reasoning effort, `attached_skills` to bake skill rules into the task prompt, `max_duration_minutes`. `action: "resume"` sends a follow-up answer to a paused task (one that asked a question). `action: "stop"` stops a running task; regular users can stop their own tasks, admins any task. See [Tasks & Cronjobs](./tasks-and-cronjobs). |
| `schedule_read` | `action: "list"` lists cronjobs and reminders with schedules, status and next run times. `action: "get"` returns one schedule's full configuration including its complete prompt. |
| `schedule_write` | `action: "create"` creates a schedule from a standard 5-field cron expression, evaluated in your `timezone`. `type: "task"` (default) runs a full background agent on every fire and accepts `provider`, `model`, `thinking_level` and `attached_skills`. `type: "reminder"` delivers a static message verbatim into the chat — no agent, no recurrence beyond the cron expression — and rejects requests that need fresh data or tools. `action: "edit"` changes only the passed fields (pass only `enabled` to toggle). `action: "remove"` deletes a schedule permanently. |

## Memory consolidation tool set

[Memory consolidation](./memory#restricted-tool-set) tasks do **not** get the tools above. They run with a fixed, path-restricted set instead:

| Tool | Notes |
|---|---|
| `file_read`, `file_list`, `file_write`, `file_edit` | Same behavior as above, but only absolute paths inside the memory locations of the run are accepted. Anything else returns `Access denied`. |
| `file_stats` | Line count and byte size of a file, or of every file in a directory (`recursive: true` includes subfolders). Replaces `wc -l` for size budgets and oversized wiki pages. |
| `file_search` | Literal text search (optionally case-insensitive) in a file or, recursively, a directory. Returns `path:line: text`, at most 200 matches. Does not follow symlinks. |
| `chat_history_read`, `memory_search` | Unchanged, scoped to the owner of the run. |

There is no `shell`, no task, cronjob, email, web, or image tool, and no `codemode`.

## Provider quota

| Tool | Notes |
|---|---|
| `provider_quota` | Returns the current subscriber usage quota — or, for credit-based gateways such as Radius and OpenRouter, the prepaid credit balance — for LLM providers (Anthropic Claude Pro/Max, ChatGPT Codex, OpenCode, z.ai, Radius, OpenRouter, …). Accepts an optional `providerId` to scope to one provider and an optional `refresh` flag to force a live fetch (for the selected provider, or all of them when `providerId` is omitted). Without `refresh`, returns the cached snapshot from the [subscriber usage quota](../web-ui/providers#subscriber-usage-quota) monitor (polled in the background). Like the provider API, the tool answers **admin users only**; a provider refreshed less than a minute ago keeps serving cached data. |

## Email

Only registered when the user the agent works for has at least one [email account](../settings/email). Each account permission maps to exactly one tool, and a tool is only registered when at least one account grants it.

| Tool | Permission | Notes |
|---|---|---|
| `email_read` | always | `action: "list"` (metadata only — sender, subject, date, UID), `"folders"`, `"read"` (one message with full body and attachment part ids; marks it read), `"mark_read"`, `"mark_unread"`. Read-only accounts keep full read access through this one tool. |
| `email_move` | `canManage` | Move messages to another folder, e.g. to archive them. |
| `email_delete` | `canDelete` | Delete messages. |
| `email_send` | `canSend` | Send or reply, with allowlist and approval rules per account. |
| `email_download_attachment` | `canDownloadAttachments` | Save an attachment into the workspace. |

## User delivery

| Tool | Notes |
|---|---|
| `file_send` | Deliver a file (≤ 50 MB) to the active user's channel — web chat or Telegram. Chat only: background tasks (including cronjob `task` runs and the heartbeat) don't get this tool, because nothing would deliver the file; they report the path and the chat agent sends it. |

---

## Optional built-in tools

These tools are part of Axiom but *off* (or behind a config) by default — usually because they need an API key, an external service, or because not every install needs them. They are only registered when enabled.

### `audio_transcribe`

Speech-to-text with the STT model selected in Settings. **Disabled by default**: it needs Speech-to-Text enabled with an STT model from a provider (Deepgram, OpenAI, Mistral, OpenRouter, xAI or a self-hosted OpenAI-compatible server) **and** [Provide as agent tool](../settings/speech-to-text#provide-as-agent-tool) switched on. The chat agent and background tasks both get it.

Parameters: `path` (audio or video file, relative to the workspace) and an optional `language` hint. Supported are audio files (mp3, wav, ogg, webm, m4a, flac) and videos (mp4, mov, mkv, avi, m4v, mpeg) — for videos, and for audio files above 24 MB, the audio track is re-encoded to a compact mono MP3 with `ffmpeg` first. ffmpeg is not part of the Docker image; without it the tool asks the agent to install it (`sudo apt-get install -y ffmpeg`). Transcripts longer than 20,000 characters are saved to `transcripts/` in the workspace and the tool returns the path plus a preview.

An optional `rewrite` flag is only offered while the [transcript cleanup](../settings/speech-to-text#rewrite-enabled) is configured; it defaults to `false`, so the agent normally gets the raw transcript.

**Where to configure:** [Settings → Speech-to-Text](../settings/speech-to-text) (`/settings?tab=stt`).

### `send_voice_message`

Replies with a spoken voice message generated by the TTS model selected in Settings — e.g. when you write "answer as a voice message" on Telegram. **Disabled by default**: it needs Text-to-Speech enabled with a TTS model **and** [Provide as agent tool](../settings/text-to-speech#provide-as-agent-tool) switched on. Chat only.

Parameters: `text` (natural speech, max 4000 characters; markdown is stripped) and an optional `format`. `format` only offers the formats the provider of the TTS model can return and is left out entirely when there is just one (OpenRouter: MP3). It defaults to the [audio format](../settings/text-to-speech#audio-format) from the settings; on Telegram it defaults to Opus when available, otherwise MP3. Telegram shows Opus and MP3 as a native voice message and WAV/FLAC as an audio file; the web chat shows an audio player.

**Where to configure:** [Settings → Text-to-Speech](../settings/text-to-speech) (`/settings?tab=tts`).

### `image_generate`

Generates or edits images with an [image generation model](./image-generation). **Registered only while image generation is switched on** under [Settings → Image Generation](../settings/image-generation) (default: on) **and at least one image model is enabled** under [Providers → Image models](../web-ui/providers#image-models); the interactive agent picks up changes with the next session, background agents as soon as the setting or the image model list changes.

Parameters: `prompt` (required), `model` (optional, defaults to the [default image model](../settings/image-generation#default-image-model)), `aspect_ratio`, `quality` and `background` (optional; how they apply depends on the [image backend](./image-generation#image-backends)), `n` (optional, 1 to the configured [max variants per call](../settings/image-generation#max-variants-per-call), default limit 4) and `input_images` (optional workspace paths to edit or combine). Images are saved under the configured [output folder](../settings/image-generation#output-folder) (default `/workspace/images/`) in a `YYYY-MM-DD/` subfolder with a JSON sidecar; the result reports paths, format, size, the cost (billed, estimated or included in a ChatGPT subscription), the duration and any parameter adjustments — never image data. Deliver files with `file_send`. The tool description points the agent to the built-in `image-generation` skill. Details: [Image Generation](./image-generation).

**Where to configure:** [Providers](../web-ui/providers#image-models) (models) and [Settings → Image Generation](../settings/image-generation) (on/off, default model, limits, output folder).

### `web_fetch`

Fetches a single URL and returns extracted readable text — scripts, styles, and HTML chrome are stripped, whitespace is normalized. **Enabled by default**, no provider choice and no key required.

Designed to pair with `web_search`: the agent searches first, picks a result, then fetches the full page. It also works standalone for any URL the user pastes into chat.

**Where to configure:** Web UI → **Skills → Built-in Tools** tab. Only one knob: enabled or not. Persisted to `settings.json`:

```json
{
  "builtinTools": { "webFetch": { "enabled": true } }
}
```

### `web_search`

Runs a search query and returns a list of `{title, url, snippet}` results. **Enabled by default** with the DuckDuckGo backend, which needs zero configuration.

Four backends are available — pick one in the UI:

| Provider | Setup | Notes |
|---|---|---|
| `duckduckgo` | nothing | Default. Zero config, no key, no external account. Rate-limited; fine for casual use. |
| `brave` | needs `braveSearchApiKey` | Enter the key in the same UI card. Stored encrypted in `builtinTools.webSearch.braveSearchApiKey`. Better quality and structured snippets; sign up at <https://api-dashboard.search.brave.com>. |
| `searxng` | needs `searxngUrl` | Point at your own SearXNG instance, e.g. `http://searxng:8080`. Best for self-hosted/private setups; no third-party calls. |
| `tavily` | needs `tavilyApiKey` | AI-optimized search API. Sign up at <https://app.tavily.com> (1,000 queries/month free). Stored encrypted in `builtinTools.webSearch.tavilyApiKey`. |

Switching the provider takes effect on the next search — no restart needed.

**Where to configure:** Web UI → **Skills → Built-in Tools** tab. Persisted to `settings.json` — the full shape with every key:

```json
{
  "builtinTools": {
    "webSearch": {
      "enabled": true,
      "provider": "duckduckgo",
      "braveSearchApiKey": "<encrypted>",
      "searxngUrl": "http://searxng:8080",
      "tavilyApiKey": "<encrypted>"
    }
  }
}
```

Only the keys relevant to the chosen `provider` are read — the others are ignored but kept around so you can switch back without re-entering them. `braveSearchApiKey` and `tavilyApiKey` are stored encrypted at rest.

### `codemode`

Experimental, **off by default**. A script tool: the agent writes a JavaScript script that calls its own tools — in parallel, chained, filtered — and only the script's output reaches the model. It is registered separately for the interactive agent and for background task agents, and each cronjob can override the task-side switch (inherit / on / off). When active, the tool description tells the agent when a script pays off (batching, chaining, filtering) and when a single call should go direct.

**Where to configure:** [Settings → Agent → Codemode](../settings/agent#codemode-experimental) (interactive agent), [Settings → Tasks → Codemode](../settings/tasks#codemode-experimental) (background tasks) and the [per-cronjob three-way control](../web-ui/cronjobs#codemode). Full details — use cases, limits, the spill folder: [Codemode](./codemode).

## Renamed tools

Older versions used other names. Skills with old names in `allowed-tools` keep working, cronjob tool overrides were migrated automatically, and old chats and logs show the same labels as new calls. The model only ever sees the new names.

| Old name | New name |
|---|---|
| `read_file`, `write_file`, `edit_file`, `list_files` | `file_read`, `file_write`, `file_edit`, `file_list` |
| `send_file_to_user` | `file_send` |
| `read_chat_history` | `chat_history_read` |
| `search_memories` | `memory_search` |
| `list_agent_skills` | `skill_list` |
| `generate_image` | `image_generate` |
| `transcribe_audio` | `audio_transcribe` |
| `list_tasks` | `task_read` |
| `create_task`, `resume_task`, `stop_task` | `task_write` (`action: create / resume / stop`) |
| `list_cronjobs`, `get_cronjob` | `schedule_read` (`action: list / get`) |
| `create_cronjob`, `create_reminder` | `schedule_write` (`action: create`, `type: task / reminder`) |
| `edit_cronjob`, `remove_cronjob` | `schedule_write` (`action: edit / remove`) |
| `email_list`, `email_folders`, `email_read`, `email_mark_read`, `email_mark_unread` | `email_read` (`action: list / folders / read / mark_read / mark_unread`) |

## See also

- [System Prompt](./system-prompt) — what the agent gets alongside the tools, and why both are built once per session.
- [Tasks & Cronjobs](./tasks-and-cronjobs) — the state machine behind `task_write` and `schedule_write`.
- [Memory System](./memory) — what `chat_history_read` and `memory_search` actually search.
- [Provider Management → Subscriber usage quota](../web-ui/providers#subscriber-usage-quota) — how the quota monitor polls providers behind the scenes.
- [Skills](./skills) — how to extend the agent beyond the built-in tool list.
- [Image Generation](./image-generation) — image models, the `image_generate` tool and its output files.
- [Codemode](./codemode) — the experimental script tool that batches, chains and filters tool calls.
