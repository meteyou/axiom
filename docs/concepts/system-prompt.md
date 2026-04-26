# System Prompt

The system prompt is the long block of text the model receives at the top of every turn — before your message, before the conversation history. It's where Axiom tells the model *who it is*, *what it knows*, *what it can do*, and *what just happened* in your recent days.

This page documents exactly how that prompt is built, what each block contains, and which file or setting drives it.

## How it's assembled

The prompt is rebuilt from scratch on **every turn** by `assembleSystemPrompt()` in `packages/core/src/memory.ts`. Each section is wrapped in an XML-style tag (`<personality>`, `<agent_rules>`, `<core_memory>`, …) so the model can clearly distinguish what each block is for.

Most layers come straight from a Markdown file under `/data/memory/` or `/data/config/`. A few are computed at request time (current datetime, the active tool list, the configured language). All of them are concatenated, separated by blank lines, and handed to the LLM as the `system` message.

Because the prompt is rebuilt every turn:

- **File edits take effect on the next message** — no restart, no reload step.
- **The current date and time are always accurate** — `<current_datetime>` reflects "now" in the configured timezone.
- **Per-user blocks only appear when that user is talking** — multi-user setups stay clean.
- **Disabled features drop out entirely** — if you have no skills installed, there is no `<available_skills>` block; if no provider is configured yet, there is no `<available_providers>` block.

## The layers

The blocks are emitted in this fixed order:

| # | Block | Source | Always present? |
|---|---|---|---|
| 1 | `<personality>` | `memory/SOUL.md` | Yes |
| 2 | `<instructions>` | Runtime base instructions (per-channel) | Optional |
| 3 | `<agent_rules>` | `config/AGENTS.md` | Yes |
| 4 | `<core_memory>` | `memory/MEMORY.md` | Yes |
| 5 | `<recent_memory>` | Last 3 days of `memory/daily/<date>.md` | When non-empty |
| 6 | `<user_profile>` | `memory/users/<username>.md` | When a user is identified |
| 7 | `<available_tools>` | Built-in tool registry + active settings | Yes |
| 8 | `<available_providers>` | Configured LLM providers + enabled models | When ≥1 provider |
| 9 | `<wiki_pages>` | Titles + aliases of `memory/wiki/*.md` | When wiki has pages |
| 10 | `<memory_paths>` | Computed paths to memory + config files | Yes |
| 11 | `<project_docs>` | Paths to the bundled `docs/` tree | Yes |
| 12 | `<agent_skills>` | Skill-creation guide + agent-skills directory | When skills dir is set |
| 13 | `<language>` | Reply-language directive | When configured |
| 14 | `<available_skills>` | Listing of installed skills (10 most recent) | When ≥1 skill |
| 15 | `<task_system>` | Background tasks, cronjobs, and reminders policy | Yes |
| 16 | `<workspace>` | Path to the agent's working directory (`/workspace`) | Yes |
| 17 | `<current_datetime>` | Current date + time in the configured timezone | Yes |
| 18 | `<channel_context>` | Notes for the active channel (e.g. Telegram) | Optional |

The order is intentional. Identity and rules come first (1–3), durable memory next (4–6), then capabilities and references (7–14), and finally the runtime anchors that tell the agent *where it is* and *when* (15–18).

## Layer details

### 1. `<personality>` — `memory/SOUL.md`

The agent's *identity*: tone, values, communication style, "vibe". This is the most stable file in memory — written once by you, rarely touched by the agent. Customize it to set the personality you want. See [Memory System → SOUL](./memory#soul-soul-md).

### 2. `<instructions>` — runtime base instructions

A small per-channel block of technical instructions injected by the runtime (e.g. the chat backend, Telegram bot, or task runner) before the agent rules. Not user-editable. Most channels leave this empty.

### 3. `<agent_rules>` — `config/AGENTS.md`

The user-editable agent contract: communication style, execution rules, anti-hallucination rules, memory rules, red lines. Read on every turn, every task, every heartbeat. See [Agent Instructions → `AGENTS.md`](./instructions#agents-md-the-agent-contract).

### 4. `<core_memory>` — `memory/MEMORY.md`

The agent's long-term scratchpad — learned lessons, recurring patterns, technical decisions, corrections. Included in every prompt, so the agent keeps it short and curated. See [Memory System → Core memory](./memory#core-memory-memory-md).

### 5. `<recent_memory>` — `memory/daily/<date>.md`

Concatenated content of the **last 3 days** of daily session notes. The agent uses this to remember what happened recently without having to re-read full chat history. The block is omitted on a fresh install with no daily files yet. See [Memory System → Daily notes](./memory#daily-notes-daily-date-md).

### 6. `<user_profile>` — `memory/users/<username>.md`

The profile of the *currently authenticated* user — name, location, communication style, work context, preferences. Loaded only when a user is identified, so the agent never mixes up users on a multi-user setup. If no user is identified, a `<user_profiles_path>` block appears instead, pointing the agent at the directory so it can read profiles on demand. See [Memory System → User profiles](./memory#user-profiles-users-username-md).

### 7. `<available_tools>` — built-in tool registry

A bullet list of every built-in tool the agent can call this turn, with a one-line description of each. The list is computed from the active tool settings — disabling `web_search` under [Settings → Agent](./../settings/agent), for example, drops that line. See [Built-in Tools](./tools).

### 8. `<available_providers>` — configured LLM providers

A short listing of every configured provider and its enabled models. Lets the agent map a user-supplied model name (*"run this with kimi-k2.6"*) onto the right provider when creating a background task or cronjob. Dropped entirely if no provider is configured yet. See [LLM Providers](./../guide/providers).

### 9. `<wiki_pages>` — `memory/wiki/*.md`

The titles and aliases of every wiki page — **not** the full content. The agent loads a specific page on demand with `read_file` when a topic comes up. This is the prompt's largest source of agent-curated knowledge while staying token-cheap. See [Memory System → Wiki](./memory#wiki-wiki-md).

### 10. `<memory_paths>` — file paths cheatsheet

The absolute paths to every memory and config file the agent might want to read or edit (`SOUL.md`, `MEMORY.md`, today's daily file, the wiki/users/sources directories, and the three config files). This is what lets the agent self-modify its memory: it doesn't have to guess where things live.

### 11. `<project_docs>` — bundled documentation

Paths to the documentation tree that ships with Axiom (this site you're reading). When you ask "how do I configure X?", the agent reads the matching file directly instead of hallucinating from training data.

### 12. `<agent_skills>` — skill creation guide

Instructions for *creating new skills* on the fly, plus the path to the agent-skills directory. Lets the agent extract a recurring workflow into a reusable `SKILL.md` when it spots a pattern. See [Skills](./skills).

### 13. `<language>` — reply language

A short directive set from [Settings → Agent](./../settings/agent#agent-language). Either *"match the user's language"* or *"always respond in `<language>`"*. Dropped if no preference is configured (model picks a sensible default).

### 14. `<available_skills>` — installed skills listing

XML-formatted listing of every installed skill — name, description, location of the `SKILL.md` file. The agent reads `SKILL.md` on demand when a request matches the description. Capped at the 10 most recent entries; older ones stay accessible via the `list_agent_skills` tool. See [Skills](./skills).

### 15. `<task_system>` — task and cronjob policy

The rules for the background-task system: when to spawn a task, how to handle task injections (completed/failed/question), how to route follow-up answers back into a paused task, and the strict ban on OS-level schedulers (use the built-in cronjob tools instead). See [Tasks & Cronjobs](./tasks-and-cronjobs).

### 16. `<workspace>` — working directory

A one-liner declaring `/workspace` as the working directory for shell commands and relative paths. Anchors all file operations so they don't accidentally land in `/data` or the OS root.

### 17. `<current_datetime>` — current date and time

The current date and time, formatted in the configured timezone. Computed at request time, so the agent always knows "now" — useful for cron creation, daily-note naming, "what day is it" questions, and any time-relative reasoning.

### 18. `<channel_context>` — channel-specific notes

A short reminder about the active surface the agent is talking on. For example, on Telegram it tells the agent *"you ARE the Telegram bot — don't suggest the user run curl commands to message you"* and to keep responses concise. Omitted on the default web chat.

## What this means in practice

A few things follow from this layout:

- **Long files cost tokens on every turn.** `MEMORY.md`, `AGENTS.md`, and `SOUL.md` are concatenated verbatim into every prompt. Keep them tight. The wiki, by contrast, only contributes its *titles* — that's why wiki content can grow unbounded without paying a per-turn cost.
- **The consolidator's job is to feed this prompt.** [Memory consolidation](./memory#memory-consolidation) is what trims daily notes into the durable layers (4, 6, 9) so the prompt stays small while long-term memory grows.
- **Per-user state is automatic.** As long as a user is authenticated, layer 6 picks the right profile — you don't have to thread username into individual rules.
- **Disabled features disappear cleanly.** If you turn off web search, the agent literally doesn't see `web_search` in `<available_tools>`. There's no out-of-band capability list.

## See also

- [Memory System](./memory) — the file layout that feeds layers 1, 4–6, and 9.
- [Agent Instructions](./instructions) — the user-editable `AGENTS.md` (layer 3) and the two non-prompt files (`CONSOLIDATION.md`, `HEARTBEAT.md`).
- [Built-in Tools](./tools) — the tools enumerated in layer 7.
- [Skills](./skills) — what powers layers 12 and 14.
