# Agent Instructions

Axiom's behavior is shaped by three plain-Markdown "instruction files" that live in `/data/config/`. They tell the agent *what to do* — how to talk, what to remember, and what to check on a schedule — while the [Settings](./../settings/) pages control *when* and *with which provider* it does those things.

This page describes all three files, what they control, and when the agent reads them. The web UI surfaces them under **Instructions** in the sidebar, with a tab per file and a **Restore default** button per tab.

> **Admin only.** The Instructions page is gated to admin users. Non-admins see a locked screen.

## The three files

| File | Role | Read by |
|---|---|---|
| `AGENTS.md` | Behavior rules the agent must follow on every turn. | Every chat turn, every task, every heartbeat run. |
| `CONSOLIDATION.md` | How the memory-consolidation job should decide what to keep, merge, or drop. | The scheduled consolidation job (see [Settings → Memory](./../settings/memory#memory-consolidation)). |
| `HEARTBEAT.md` | The prompt the agent receives on each heartbeat tick. | The heartbeat loop (see [Settings → Agent Heartbeat](./../settings/agent-heartbeat)). |

All three are shipped with a sensible default template on first startup. You can edit them via the UI's **Instructions** page, directly on the filesystem, or restore the built-in default at any time.

## Where they sit in the system prompt

`AGENTS.md` is the only one of the three that lands in the live chat system prompt — as layer 3, the `<agent_rules>` block:

| # | Block | Source |
|---|---|---|
| 1 | `<personality>` | `memory/SOUL.md` |
| 2 | `<instructions>` | Runtime-set (tool-specific instructions) |
| 3 | **`<agent_rules>`** | **`config/AGENTS.md`** |
| 4 | `<core_memory>` | `memory/MEMORY.md` |
| 5 | `<recent_memory>` | `memory/daily/<last 3 days>.md` |
| 6 | `<user_profile>` | `memory/users/<current-user>.md` |
| 7 | `<wiki_pages>` | `memory/wiki/*.md` (titles only) |

See [Memory System → The seven layers](./memory#the-seven-layers-of-the-system-prompt) for the full picture.

`CONSOLIDATION.md` and `HEARTBEAT.md` are *not* injected into the chat prompt — they're read only when their respective jobs run.

## `AGENTS.md` — the agent contract

**Path:** `/data/config/AGENTS.md`  
**Tab:** Agent Rules  
**When read:** Every conversation, every task, every heartbeat.

This is the single most important file for shaping day-to-day behavior. It defines *how* the agent communicates, what it's allowed to do autonomously, and where it should stop and ask.

### What the default template covers

The shipped template has five sections — use them as a starting point, rewrite whatever doesn't fit:

| Section | Purpose |
|---|---|
| **Communication Style** | Tone, verbosity, formatting conventions. |
| **Execution Rules** | When to ask vs. act; how to handle ambiguity, destructive changes, external actions. |
| **Anti-Hallucination Rules** | "Say I don't know." Strict-mode vs. creative-mode. Citing sources. |
| **Memory Rules** | What belongs in `MEMORY.md` vs. daily files vs. user profiles. |
| **Red Lines** | Hard "never do this" boundaries. |

### Keep it tight

`AGENTS.md` is concatenated verbatim into *every* system prompt. Long rulebooks cost tokens on every turn and dilute the model's attention. Good rules are:

- **Imperative** ("Prefer small, verifiable changes over large rewrites.")
- **Observable** (the user can tell if it's followed)
- **Rare-but-memorable** — not a phrase book; the model already knows English

If you catch yourself writing "the agent should be helpful and friendly" — cut it. Save that kind of guidance for `SOUL.md`.

### Example snippet

```md
## Communication Style

- Start with the point — no warm-up, no praise, no conversational padding.
- Default verbosity: low — scale up only when the topic genuinely requires it.
- Never use bold text as a substitute for a heading.

## Execution Rules

- Be resourceful before asking — read files, check context, search first.
- Ask before destructive changes (deleting files, dropping data, overwriting config).
- When multiple approaches exist, recommend one with its tradeoff.
```

## `CONSOLIDATION.md` — memory consolidation rules

**Path:** `/data/config/CONSOLIDATION.md`  
**Tab:** Consolidation Rules  
**When read:** Each scheduled consolidation run (see [Settings → Memory → Memory consolidation](./../settings/memory#memory-consolidation)).

The consolidation job condenses the last few days of `memory/daily/<date>.md` files into durable entries in `MEMORY.md`, user profiles, and the wiki — then trims the dailies. `CONSOLIDATION.md` is the prompt that tells it how to judge each candidate entry.

### What the default template covers

The shipped template maps out the **memory architecture** and gives explicit rules for each tier:

- **Promote to `MEMORY.md`** — recurring patterns, technical decisions, persistent facts, corrections.
- **Update user profiles** (`memory/users/*.md`) — preferences, work context, personal details the user shared.
- **Update wiki pages** (`memory/wiki/*.md`) — project discoveries, architecture notes, evergreen concepts.
- **Archive under `sources/`** — immutable raw material (articles, transcripts, papers) the wiki cites.
- **Ignore** — ephemeral one-shot commands, temporary paths, noise.

Customize it to match your taxonomy. For example, if you don't use the `wiki/` layer at all, remove that section so the consolidator stops trying.

### Tuning tips

- If your `MEMORY.md` grows unbounded, tighten the "promote" section — raise the bar.
- If you find user profiles get bloated, move those rules into "ignore" for that user's style.
- If the consolidator keeps duplicating entries across `MEMORY.md` and user profiles, add an explicit "prefer user profile for anything person-specific" rule.

## `HEARTBEAT.md` — scheduled self-prompts

**Path:** `/data/config/HEARTBEAT.md`  
**Tab:** Heartbeat Tasks  
**When read:** Every heartbeat tick (interval configured in [Settings → Agent Heartbeat](./../settings/agent-heartbeat)).

The heartbeat makes the agent wake up on a schedule with *no user message* and run a short self-driven turn. `HEARTBEAT.md` is the prompt it receives on every tick.

### Default template

The template is intentionally empty-ish:

```md
# Heartbeat Tasks

<!-- Define periodic tasks here. The agent will execute them during each heartbeat cycle. -->
<!-- Both the user and the agent can edit this file. -->
<!-- If this file has no actionable content, the heartbeat will skip automatically. -->
```

If the file has no actionable content, the heartbeat silently no-ops — enabling the feature in Settings without filling this file is safe.

### What belongs here

One-line tasks the agent should run on its own, in sequence, on every tick. Keep the list short — every line is processed on every heartbeat.

```md
# Heartbeat Tasks

1. Scan /data/memory/MEMORY.md for items marked TODO. Act on the oldest one if feasible, otherwise leave it.
2. Check open cronjobs: if any are overdue by more than 24h, flag them in today's daily file.
3. If it's the first tick of a new day (per timezone), write a one-line "good morning" entry to the daily file and stop.
```

### What does *not* belong here

- Anything requiring user input. The heartbeat has no user to talk back to.
- Long-running work. Use [Tasks & Cronjobs](./tasks-and-cronjobs) instead — they have proper duration limits, loop detection, and status updates.
- Experiments. Broken rules here cost you one tick interval's worth of API calls every interval. Test in a one-shot task first, then promote.

## Editing from the UI

The **Instructions** page in the web UI gives each file its own tab with a larger editor than the settings panels' "Open editor" buttons provide:

- **Switch tabs** to edit a different file. The URL updates to `?file=agents | consolidation | heartbeat` so you can deep-link.
- **Save changes** commits the file. Next agent turn picks it up.
- **Restore default** overwrites the current content with the shipped template (after a confirmation dialog). Useful when an experiment goes wrong.

## Editing from the filesystem

All three files are plain Markdown. Nothing stops you from editing them directly:

```bash
docker compose exec openagent vi /data/config/AGENTS.md
docker compose exec openagent vi /data/config/CONSOLIDATION.md
docker compose exec openagent vi /data/config/HEARTBEAT.md
```

There's no reload step — the next time the relevant surface reads the file (chat turn for `AGENTS.md`, consolidation job for `CONSOLIDATION.md`, heartbeat tick for `HEARTBEAT.md`), your edits are in effect.

## Migration notes

Older Axiom versions stored `AGENTS.md` and `HEARTBEAT.md` under `/data/memory/`. On startup, Axiom moves them to `/data/config/` automatically and logs the migration. No action required.

`CONSOLIDATION.md` is created from the default template on first startup if it doesn't exist.

## See also

- [Memory System](./memory) — the broader file layout and system prompt layers.
- [Settings → Agent](./../settings/agent#agent-rules) — jump-off point for `AGENTS.md` from the Agent panel.
- [Settings → Memory](./../settings/memory#memory-consolidation) — consolidation schedule, provider, and manual "Run now".
- [Settings → Agent Heartbeat](./../settings/agent-heartbeat) — heartbeat interval, night mode.
