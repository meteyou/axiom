# Memory System

Axiom uses a **file-based, plain-Markdown memory system**. Everything the agent remembers lives under `/data/memory/` as readable, hand-editable files. There is no opaque vector blob — you can `cat`, `grep`, and `git diff` your agent's memory.

## Why files?

- **Inspectable.** You always know what the agent thinks it knows.
- **Portable.** Back up the volume, you've backed up the memory.
- **User-editable.** Override or correct anything via the web UI's Memory page or by editing the file directly.
- **Composable.** The agent assembles a layered system prompt from these files on every turn.

## The layout

```
/data/
├── memory/
│   ├── SOUL.md                  ← personality
│   ├── MEMORY.md                ← long-term core memory (lessons, facts)
│   ├── daily/
│   │   ├── 2025-01-14.md        ← per-day session notes
│   │   └── …
│   ├── users/
│   │   ├── stefan.md            ← per-user profile (name, prefs, context)
│   │   └── …
│   ├── wiki/
│   │   ├── axiom.md              ← agent-maintained knowledge base
│   │   └── …
│   └── sources/                 ← raw material the wiki cites (immutable layer)
└── config/
    ├── AGENTS.md                ← user-editable behavior rules
    ├── HEARTBEAT.md             ← recurring self-check tasks
    └── CONSOLIDATION.md         ← rules for daily memory consolidation
```

## The seven layers of the system prompt

Every time the agent processes a message, `assembleSystemPrompt()` builds the prompt from these layers (in order):

| # | Block | Source | Edited by |
|---|---|---|---|
| 1 | `<personality>` | `memory/SOUL.md` | User |
| 2 | `<instructions>` | (set by the runtime, e.g. tool-specific instructions) | Code |
| 3 | `<agent_rules>` | `config/AGENTS.md` | User |
| 4 | `<core_memory>` | `memory/MEMORY.md` | Agent (writes via `edit_file`) |
| 5 | `<recent_memory>` | `memory/daily/<last 3 days>.md` | Agent + memory consolidation |
| 6 | `<user_profile>` | `memory/users/<current-user>.md` | Agent |
| 7 | `<wiki_pages>` | List of `memory/wiki/*.md` (titles + aliases only — agent reads on demand) | Agent |

Plus several deterministic blocks: `<available_tools>`, `<available_providers>`, `<memory_paths>`, `<project_docs>`, `<agent_skills>`, `<language>`, and `<available_skills>`.

## What goes where

| Information | File | Why |
|---|---|---|
| Personality, tone, values | `SOUL.md` | Stable across all conversations. Rewrite to change the agent's "vibe". |
| User-editable behavior rules ("ask before destructive changes") | `config/AGENTS.md` | The user owns these — easy to override via UI without losing them on upgrade. |
| Long-term learned facts ("user prefers `npm` over `yarn`") | `MEMORY.md` | Persisted forever, included in every prompt. Keep it short. |
| Daily session notes ("today we set up the Telegram bot") | `daily/<date>.md` | Rolling 3-day window in the prompt; older entries get consolidated into `MEMORY.md`. |
| Per-user info (name, location, work context) | `users/<username>.md` | Loaded only when that user is talking to the agent. |
| Structured knowledge ("How does our deploy pipeline work?") | `wiki/<topic>.md` | Listed in the prompt by title; the agent reads them on demand via `read_file`. |
| Raw source material the wiki cites | `sources/` | Immutable layer — wiki pages reference sources in a `## Sources` section. |
| Settings (language, timezone, providers) | `config/settings.json` | Single source of truth — **not** mirrored into memory files. |

> **Don't duplicate.** Language and timezone live only in `settings.json`. User identity lives only in `users/<name>.md`. Tool-usage instructions live only in the system prompt.

## How the agent updates memory

The agent has direct access to its own memory via the standard `read_file`, `write_file`, and `edit_file` tools. The system prompt's `<memory_paths>` block tells it the exact paths.

- For **small additions** (a new fact, a corrected entry) the agent uses `edit_file` with a precise `oldText → newText` replacement. This saves tokens and avoids accidental destruction.
- For **larger restructures** (consolidating duplicated entries) it uses `write_file` after reading the current content.

You can do the same from outside the container:

```bash
docker compose exec openagent vi /data/memory/MEMORY.md
docker compose exec openagent vi /data/config/AGENTS.md
```

The next time the agent receives a message, the new content is in the prompt.

## Memory consolidation (optional)

When **`memoryConsolidation.enabled: true`** in `settings.json`, a scheduled job runs at `runAtHour` and condenses the last `lookbackDays` of daily files into entries in `MEMORY.md`, then trims the daily files. This keeps long-term memory rich and the prompt small.

Configure in the UI under **Settings → Memory Consolidation**, or directly in `/data/config/settings.json`:

```json
"memoryConsolidation": {
  "enabled": true,
  "runAtHour": 3,
  "lookbackDays": 3,
  "providerId": "openai-gpt4o-mini"
}
```

## Fact extraction (optional)

When **`factExtraction.enabled: true`**, after every session ending with at least `minSessionMessages` messages, Axiom runs the conversation through a small extraction model and writes durable facts into the `agent_facts` table. The agent retrieves these via the `search_memories` tool — useful when memory grows beyond what fits in a prompt.

## The wiki layer

The wiki is the agent's own knowledge base. Pages are titled, optionally aliased (frontmatter `aliases: [Foo, foo-thing]`), and listed in the system prompt by title. The agent reads them on demand and maintains them autonomously: it adds new pages, extends existing ones, merges duplicates, and links between them.

The agent uses the bundled `wiki` skill (`/data/skills_agent/wiki/SKILL.md`) for non-trivial wiki work. Routine edits don't require user confirmation; only genuine contradictions (new info conflicts with an existing page) get escalated.

## Editing memory from the UI

The **Memory** page in the web UI surfaces:

- `SOUL.md` and `MEMORY.md` as inline editors
- `AGENTS.md` (the user-editable rules) as an inline editor
- A list of daily files, user profiles, and wiki pages with read/edit access
- A button to trigger memory consolidation manually

Changes are written directly to the underlying files and picked up on the next agent turn — no restart needed.

## Migration & defaults

On first startup the entrypoint creates `SOUL.md`, `MEMORY.md`, and `AGENTS.md` from built-in templates if they don't exist. The templates are conservative — go customize them.

If you previously ran an older version that stored `AGENTS.md` under `/data/memory/`, Axiom will migrate it to `/data/config/AGENTS.md` on next startup and log the move.

## Two `AGENTS.md`, do not confuse

- **`/data/config/AGENTS.md`** (runtime, user-editable) — behavior rules the agent follows when talking to users. Shipped as a template, intended to be customized.
- **`/AGENTS.md` in the source repo** (developer-facing) — guidelines for coding agents working on the Axiom codebase. Never seen by the running agent.
