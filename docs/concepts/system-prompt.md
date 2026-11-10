# System Prompt

The system prompt is the long block of text the model receives at the top of every request — before your message, before the conversation history. It's where Axiom tells the model *who it is*, *which rules it follows*, *what it remembers* and *where its files live*.

This page documents exactly how that prompt is built, what each block contains, and which file or setting drives it.

## How it's assembled

The prompt is built by [`assembleSystemPrompt()` in `packages/core/src/memory.ts`](https://github.com/meteyou/axiom/blob/main/packages/core/src/memory.ts). Each section is wrapped in an XML-style tag (`<personality>`, `<agent_rules>`, `<core_memory>`, …) so the model can clearly distinguish what each block is for.

Most layers come straight from a Markdown file under `/data/memory/` or `/data/config/` (see [Container file paths](./../reference/file-paths)). A few are computed when the prompt is built (the hard-coded system rules, the provider list, the paths block, the configured language). All of them are concatenated, separated by blank lines, and handed to the LLM as the `system` message.

What the prompt deliberately does **not** contain:

- **No tool overview.** The model reads the tool definitions themselves; usage hints (prefer `file_edit` over `file_write`, `web_fetch` after `web_search`, load the image skill before `image_generate`, when codemode pays off) live in each tool's description. See [Built-in Tools](./tools).
- **No wiki page list.** The agent finds wiki pages with `memory_search`. See [Memory System → Wiki](./memory#wiki-wiki-md).
- **No date or channel.** Both change during a session, so they travel with each user message instead — see [Per-message context](#per-message-context).

## Built once per session

The system prompt **and** the tool list are built once, on the first turn of a session — your first message, or a background-task result that arrives first. After that they stay byte-identical for the whole session, so the provider prompt cache (Anthropic / OpenAI prompt caching) hits on every turn.

They are rebuilt only in two situations:

- **A new session starts** — you run `/new` in the [web chat](./../web-ui/chat) or on [Telegram](./../guide/telegram), or the session ends after `sessionTimeoutMinutes` of inactivity (see [Settings → Memory](./../settings/memory)).
- **The conversation is [compacted](./compaction)** — the cache is invalidated at that point anyway, so the prompt is rebuilt with fresh content.

::: tip Changes apply from the next session
Edits to `AGENTS.md`, `SOUL.md`, `MEMORY.md` or your profile, newly installed or created skills, the reply language, provider descriptions, and toggling codemode or image generation **do not change the running session**. They take effect with the next session: run `/new` to pick them up right away. No server restart is needed.
:::

A few more properties of this layout:

- **Per-user blocks only appear for the user who is talking** — multi-user setups stay clean.
- **Disabled features drop out entirely** — with no skills installed there is no `<available_skills>` block; with no provider configured there is no `<available_providers>` block.

## The layers

The blocks are emitted in a fixed order. Identity and rules come first, durable memory and the current user next, then capabilities, and finally the paths cheatsheet and the reply language.

### `<personality>`: `memory/SOUL.md`

*Always present.*

The agent's *identity*: tone, voice, character, "vibe". This is the most stable file in memory — written once by you, rarely touched by the agent. Customize it to set the personality you want. Concrete *do/don't* rules ("no filler", "use markdown lists") belong in `AGENTS.md` instead. See [Memory System → SOUL](./memory#soul-soul-md).

### `<instructions>`: runtime base instructions

*Optional. Empty in every channel that ships today.*

A small per-channel block of technical instructions a runtime can inject before the agent rules. Not user-editable; reserved for future surfaces that need a hard, non-negotiable preamble.

### `<agent_rules>`: `config/AGENTS.md`

*Always present.*

The user-editable agent contract: communication rules, execution rules, anti-hallucination rules, memory rules, wiki rules, docs rules, red lines. Where `<personality>` answers *who the agent is*, `<agent_rules>` answers *what it concretely does and doesn't do*. See [Agent Instructions → `AGENTS.md`](./instructions#agents-md).

### `<system_rules>`: hard-coded rules

*Always present. Not editable.*

Safety-critical rules that must not disappear when you rewrite `AGENTS.md`:

- **No OS-level schedulers** — never system `crontab`, `launchd`, `at` or shell-spawned background loops; always the built-in task and cronjob tools.
- **Task-injection trigger** — when a `<task_injection>` block (a background-task result) arrives, load the [`tasks-and-cronjobs`](./skills#currently-shipped) skill before responding.

On an instance with [several users](./multi-user), the block also carries the **shared-data rules**: profile, daily notes, workspace and chat history are private; the wiki, `MEMORY.md` and skills are shared, so personal information never goes there. For regular (non-admin) users it adds the **admin-managed config rule**: the agent refuses to change `SOUL.md`, `AGENTS.md`, `TASKS.md`, `CONSOLIDATION.md`, providers or global settings and tells the user to ask the admin. A single-user install gets neither.

### `<core_memory>`: `memory/MEMORY.md`

*Always present.*

The agent's long-term scratchpad — learned lessons, recurring patterns, technical decisions, corrections. Included in every prompt, so the agent keeps it short and curated. On a multi-user instance it is labelled as shared memory. See [Memory System → Core memory](./memory#core-memory-memory-md).

### `<recent_memory>`: `memory/daily/<date>.md`

*Present when there is non-empty content in the last 3 daily files.*

Concatenated content of the **last 3 days** of daily session notes. A short preamble reminds the agent that these are condensed and that the full conversation is available via the `chat_history_read` tool. The block is omitted on a fresh install with no daily files yet. See [Memory System → Daily notes](./memory#daily-notes-daily-date-md).

### `<current_user>` and `<user_profile>`: `memory/users/<username>.md`

*Present when a user is identified.*

The username and role of the *currently authenticated* user, followed by their profile — name, location, communication preferences, work context, interests. Loaded only for the user who is talking, so the agent never mixes up users. For every user except the first account, recent memory and the profile come from `/data/users/<username>/`. See [Memory System → User profiles](./memory#user-profiles-users-username-md).

### `<available_providers>`: configured LLM providers

*Present when at least one LLM provider has a routable model or at least one image generation model is enabled.*

A listing of provider/model pairs that the agent can route background tasks to. Only models that carry a **description** (set via the [Edit Model dialog](./../web-ui/providers#edit-model-dialog)) or are the active agent model / default task model are included — the description doubles as an opt-in gate for agent model routing.

Each entry shows the provider name, the model id, default-model labels (*"default agent model"*, *"default task model"*), the free-form description, and the thinking levels the model supports (`thinking: off, low, high, …`). The block also states the current background thinking level and tells the agent it may pass `provider`, `model` and `thinking_level` to `task_write` / `schedule_write`, choosing models autonomously based on the descriptions (cost-effective models for simple work, stronger models for complex tasks). See [Providers](./../web-ui/providers).

When image generation models are enabled, the block additionally contains a separate **Image generation models** list. It names every usable image model (no description gate), marks the [default image model](./../settings/image-generation#default-image-model) and appends its description. These models can only be used with `image_generate` (via its `model` parameter), never for chat, tasks or cronjobs. See [Image Generation](./image-generation).

### `<available_skills>`: installed skills listing

*Present when at least one skill is active.*

XML-formatted listing of every active skill — name, description, location of the `SKILL.md` file, and an optional `<warning>` (e.g. when a skill needs an env var that isn't set). The agent reads `SKILL.md` with `file_read` when a request matches the description. Built-in and user-installed skills are listed in full; **agent-created** skills are capped at the 10 most recently used, with the rest reachable through the `skill_list` tool. When you ask the agent to save a workflow as a skill, it finds the built-in `skill-creator` skill here. See [Skills](./skills).

### `<paths>`: every path the agent needs

*Always present.*

One block with every file and directory the agent works with, so it never has to guess:

- **Workspace** — `/workspace`, or `/workspace/<username>` for every user except the first account. The default directory for shell commands and relative paths.
- **Memory** — your profile, the daily notes directory (one `YYYY-MM-DD.md` file per day; the agent takes the date from `<current_time>`), `MEMORY.md`, `SOUL.md`, the wiki and sources directories.
- **Skills** — the agent skills directory (`/data/skills_agent/`), where new skills are written.
- **Config files** *(admins only)* — `AGENTS.md`, `HEARTBEAT.md`, `CONSOLIDATION.md`, `TASKS.md`.
- **Axiom docs** *(read-only)* — the README and the `concepts/`, `guide/` and `reference/` directories of this documentation. When you ask *"how do I configure X?"*, the agent reads the matching file instead of guessing from training data.

On a multi-user instance, users other than the first account see their personal files and the shared files in two groups. Regular users get no config paths.

### `<language>`: reply language

*Present when a reply language is configured.*

A short directive set from [Settings → Agent](./../settings/agent#agent-language): either *"match the user's language"* or *"always respond in `<language>`"*. Placed at the end on purpose, so the directive lands close to the user message.

## Per-message context

Two things change during a session and are therefore attached to the **user message** instead of the system prompt:

- **`<current_time>`** — date, weekday, time and timezone, appended to every user message. Sessions that span midnight never work with a stale date, and the cached prompt prefix stays untouched.
- **`<channel_context>`** — prepended when the channel matters:
  - On the first Telegram message of a session, and whenever you switch from the web chat to [Telegram](./../guide/telegram), the agent is told *"you ARE the Telegram bot — don't suggest the user run curl commands to message you"* and to keep responses concise.
  - When you switch back from Telegram to the web chat, a short note tells the agent the Telegram constraints no longer apply.
  - The web chat on its own gets no note, and nothing is added while the channel stays the same.

Background-task results follow the same rules. Before a result is injected, Axiom decides whether the answer goes to the web chat or to Telegram (with *Telegram delivery: always*, Telegram wins), so the agent formats it for the channel you actually read it on.

## What this means in practice

- **Long files cost tokens on every request.** `MEMORY.md`, `AGENTS.md`, and `SOUL.md` are concatenated verbatim into every prompt. Keep them tight. The wiki, by contrast, costs nothing until the agent searches it — that's why it can grow without bloating every request.
- **The consolidator's job is to feed this prompt.** [Memory consolidation](./memory#memory-consolidation) trims daily notes into the durable layers so the prompt stays small while long-term memory grows.
- **Per-user state is automatic.** As long as a user is authenticated, the right profile is loaded — you don't have to thread usernames into individual rules.
- **Want a change now? Start a new session.** Run `/new` after editing memory files, skills or settings.

## See also

- [Memory System](./memory) — the file layout that feeds personality, core memory, recent memory and the user profile.
- [Agent Instructions](./instructions) — the user-editable `AGENTS.md` and the non-prompt files (`CONSOLIDATION.md`, `HEARTBEAT.md`, `TASKS.md`).
- [Built-in Tools](./tools) — the tools the agent gets alongside the prompt.
- [Skills](./skills) — what powers `<available_skills>`.
- [Tasks & Cronjobs](./tasks-and-cronjobs) — the system referenced by the system rules.
- [Context Compaction](./compaction) — when the prompt is rebuilt mid-session.
- [Container file paths](./../reference/file-paths) — where `/data` and `/workspace` actually live on disk.
