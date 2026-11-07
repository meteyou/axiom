# Tasks & Cronjobs

Axiom has three related but distinct ways to run work *outside the current chat turn*: **tasks** (one-shot background runs), **cronjobs** (recurring scheduled runs), and **reminders** (scheduled static text, usually one-shot). They share the same underlying machinery — a SQLite-backed scheduler, a `TaskRunner` that spawns isolated agents, and a notification layer that funnels results back into the right chat session — but they're meant for different kinds of work.

| | **Tasks** | **Cronjobs** | **Reminders** |
|---|---|---|---|
| Trigger | Fire-and-forget, on demand | Recurring on a 5-field cron schedule | At a future time (5-field cron), usually once |
| Agent tools | `task_read`, `task_write` | `schedule_read`, `schedule_write` with `type: "task"` | `schedule_read`, `schedule_write` with `type: "reminder"` |
| Spawns an agent? | Always | Always | Never — static text |
| Tools / skills available? | Full registry, plus optional `attached_skills` | Full registry (task type only), plus optional `attached_skills` | None |
| Typical use | "Build this app." "Refactor X across the repo." | "Every weekday at 9, summarize my GitHub notifications." | "Remind me at 17:30 to leave for the train." |

Defaults — provider, max duration, loop detection, telegram delivery, status updates, background thinking level — live in **Settings → Tasks** (see [Settings → Tasks](./../settings/tasks)). Everything below is the *mechanism*: how each flavor actually runs, what guarantees Axiom makes, and what to expect when things go wrong.

> The agent-facing usage guide — when to pick which, how to write good task prompts, how to handle `<task_injection>` blocks — lives in the built-in [`tasks-and-cronjobs`](./skills#currently-shipped) skill so it only costs tokens when the agent is actually creating background work. This page is the architectural reference.

## Tasks

A **task** is a self-contained agent run that proceeds in the background. The user (or the agent itself) hands off a prompt; a fresh agent instance spins up in isolation, works through the prompt with the full tool and skill registry, and reports back when it's done.

### Lifecycle

A task moves through four states, persisted in the `tasks` SQLite table. Rows are inserted directly as `running` — there is no `queued` state, the `TaskRunner` starts the agent inline.

```text
running ──┬──▶ completed
          ├──▶ failed
          └──▶ paused ──▶ running ──▶ …
```

- **`running`** — the agent is actively working. The `TaskRunner` keeps the live agent instance in memory in a `runningTasks` map.
- **`paused`** — the agent's final output had `STATUS: question`, so it's blocked waiting for a follow-up. The agent stays in memory in a `pausedTasks` map, ready to resume.
- **`completed`** — final status was `completed` or `silent`. `silent` means the task chose not to emit a chat message (e.g. a periodic cronjob that found nothing to report).
- **`failed`** — the agent threw, hit the duration cap, or got terminated by [loop detection](./../settings/tasks#loop-detection).

Paused agents that nobody resumes are garbage-collected after a stale-cleanup interval; their database row stays as `paused` but the in-memory agent is gone, so calling `task_write` with `action: "resume"` on them returns *"agent is no longer in memory"*.

### Isolation

Every task runs in its own agent instance with its own session ID — separate from the parent chat. A task agent has:

- **No chat history.** It cannot read what was said in the conversation that triggered it. Anything it needs has to be in the `prompt` field.
- **A different system prompt.** Built by [`buildTaskSystemPrompt`](https://github.com/meteyou/axiom/blob/main/packages/core/src/task-system-prompt.ts) — it tells the agent *"You are a background task agent. You are NOT a chatbot — you are an autonomous worker"*, injects the user-editable `<task_guidelines>` block from [`TASKS.md`](./instructions#tasks-md) and the task owner, and enforces the `STATUS: … / SUMMARY: …` final-message format described below. It reuses the same `<paths>` block and hard-coded `<system_rules>` as the [chat agent's prompt](./system-prompt), plus one task rule: work inside the workspace, never in `/tmp` or elsewhere.
- **The full toolset and skill index.** The same tools and `<available_skills>` as a chat agent, except `file_send`. `task_write` (`action: "create"`) and `schedule_write` (`type: "task"`) can additionally pin specific skills via [`attached_skills`](#attached-skills).
- **A fresh provider/model session.** The task either uses the configured task default provider (Settings → Tasks) or whatever was explicitly pinned at creation time.

### Ownership and privacy

Every task belongs to one user. A task started in chat belongs to the user who chatted; tasks of cronjobs, heartbeat and consolidation belong to the bootstrap admin until those features get owners of their own. Existing tasks are attributed to the user of their originating chat session, or to the bootstrap admin when that cannot be determined.

The task agent is built for its owner and runs with the owner's context only:

- **Workspace.** Shell commands, `file_read`/`file_write` and generated images use the owner's workspace (`/workspace` for the bootstrap admin, `/workspace/<username>/` for everyone else). The task prompt points at it.
- **Memory.** `memory_search` and `chat_history_read` return only the owner's facts and conversations. The prompt references the owner's profile and daily notes next to the shared `MEMORY.md` and wiki.
- **Delivery.** Results, questions and periodic status updates go only to the owner, in the web chat and on the owner's linked Telegram account.

Access follows one policy for the web UI, the agent tools and the slash commands:

| | Owner | Another regular user | Admin on a foreign task |
|---|---|---|---|
| See in lists (`/tasks`, `task_read`, Tasks page) | yes | no | Tasks page: everything. Agent and `/tasks`: only title, owner and status — never prompt or result |
| Open and stream details | yes | no | web UI only |
| Stop / kill | yes | no | yes |
| Restart, resume | yes | no | no |

The agent stops a running task with `task_write` (`action: "stop"`): regular users can stop their own tasks, an admin can stop any task. `action: "resume"` only works on your own tasks, for everyone. A task you may not see is reported as not found.

### Triggers

The `tasks.trigger_type` column records *who created the task*. There are five trigger types:

| Trigger | Meaning |
|---|---|
| `user` | Manually started from the **Tasks** page in the web UI. |
| `agent` | The chat agent called `task_write` (`action: "create"`) mid-conversation. |
| `cronjob` | A scheduled cronjob (`type: "task"`) fired and spawned this run. |
| `heartbeat` | The [agent heartbeat](./../settings/agent-heartbeat) ticked and produced an actionable item. |
| `consolidation` | The memory-consolidation job spawned a task to act on a candidate entry. |

The trigger flows through into the `<task_injection>` block (see below) so the chat agent knows whether the result it's reading came from a user-initiated job or a scheduled run, and can phrase the reply accordingly.

### Final-message format

The task system prompt requires the agent to end its run with exactly:

```text
STATUS: completed | failed | question | silent
SUMMARY:
<full content here>
```

The runner parses this with `parseTaskOutput` in `task-runner.ts`. If the agent forgets the format, the runner falls back to using the whole text as the summary and assumes `completed`. Each status has a specific meaning:

| Status | Meaning |
|---|---|
| `completed` | The work is done. The `SUMMARY` is the final deliverable — it gets piped into the parent chat verbatim. |
| `failed` | Unrecoverable error. The `SUMMARY` explains what went wrong. The task row is marked `failed` with an error message. |
| `question` | The agent is blocked and needs the user. The `SUMMARY` contains *one* concrete question. The task transitions to `paused` instead of terminating, and the `<task_injection>` block flags `status="question"` so the parent agent relays the question conversationally. |
| `silent` | Nothing to report — terminate cleanly without delivering a chat message. The task is recorded as `completed` but no `<task_injection>` is emitted to the user. Use case: periodic checks that found no changes. |

If the final turn ends without an answer, the task is marked `failed` instead of `completed` with an empty summary, and the reason becomes the error message:

- **Provider error** — the request failed (HTTP error, dropped stream). The provider's error message is reported.
- **Output token limit hit before any answer text** — the model used up its output budget while still reasoning. When the conversation approaches the model's context window, the output budget shrinks to fit the remaining space, down to a single token. A reasoning model then emits one thinking token and stops. If the error mentions the configured context window, set the model's real context window under **Token limits** in the [Edit Model dialog](../web-ui/providers#edit-model-dialog). Custom OpenAI-compatible models without a value default to 128k.
- **Turn ended without answer text** — the model finished normally but wrote no text, or only whitespace. Some reasoning models emit only reasoning content and then stop. The error names the model, the stop reason and the output token count.
- **No assistant response** — the run ended without any assistant message.

### `<task_injection>`: how results come back

When a task terminates (or pauses), the `TaskRunner` builds a `<task_injection>` block and calls the configured `onTaskComplete` / `onTaskPaused` callback. The orchestrator in `agent.ts` calls `injectTaskResult` which inserts that block into the parent session as a system message and resumes the parent agent if it isn't already running.

Concretely, the parent agent's *next* turn starts with a system-role message like:

```xml
<task_injection task_id="…" task_name="…" status="completed|failed|question"
  trigger="user|agent|cronjob|heartbeat|consolidation"
  duration_minutes="…" tokens_used="…">
… SUMMARY content …
</task_injection>
```

The parent agent's job is to *translate* this into a natural reply — the hard-coded [`<system_rules>`](./system-prompt#system-rules-hard-coded-rules) tell it to load the `tasks-and-cronjobs` skill before responding, which carries the conventions (don't echo the raw block, route follow-ups via `task_write` with `action: "resume"`, …).

If the injection is the first turn of a chat session, it builds the session's [system prompt and tool list](./system-prompt#built-once-per-session). Before the result is injected, Axiom resolves where the answer will be delivered — web chat or Telegram, following the [Telegram delivery](./../settings/tasks) setting (with `always`, Telegram wins) — and adds the matching [channel note](./system-prompt#per-message-context), so a result you read on Telegram is written for Telegram.

### Resuming a paused task

When the user replies after a `status="question"` injection, the agent calls [`task_write`](https://github.com/meteyou/axiom/blob/main/packages/core/src/task-tools.ts) with `action: "resume"`, the `task_id` and a `message` containing the user's answer plus enough context for the task to continue (the original question, any conversation snippets that clarify, file paths that came up — the paused task has no chat history of its own).

The resume action validates that:

1. The task exists and is in status `paused`.
2. The agent is still in memory (`pausedTasks` map). If it's been garbage-collected, the call fails with *"agent is no longer in memory. The task may have timed out."*

If both checks pass, the task transitions back to `running` and the next `<task_injection>` arrives when it's done or has another question.

### Recovery after a server restart

When the backend restarts, `recoverTasks()` handles every task the database still lists as active:

- **`paused`** tasks are marked `failed` — their in-memory agent is gone. Re-ask the question to start over.
- **`running`** tasks are restarted as a new task named `<name> (resumed)` with the original prompt. The old row is marked `failed` and its summary points to the new task ID.

The resumed prompt carries a `<recovery_context>` block built from the task tool journal (`task_tool_journal` table). The runner writes a journal row *before* each tool call starts and finalizes it when the call ends, so the resumed agent sees:

- **Finished calls** in order, with arguments and a result preview. The 25 most recent calls are shown in full; older ones as a name + status line.
- **Interrupted calls** — started but never finished because the process died mid-call. Each tool is classified as replay-safe or not:
  - **Safe** (reads like `file_read`, `web_fetch`, `task_read`, `schedule_read`, plus every `email_read` action — listing, reading and the idempotent read/unread flags): *"Interrupted; safe to re-run."*
  - **Unsafe** (everything else, e.g. `shell`, `file_write`, `email_send`, every `task_write` and `schedule_write` action): *"Interrupted; outcome UNKNOWN."* The agent has to check the current state (git remote, sent folder, file contents) before deciding whether to repeat the call.

Grouped tools are classified per action, and journal entries recorded under an old tool name are classified by its new name. Unknown tools default to unsafe. Tasks that crashed before the journal existed fall back to a short summary of their last ten `tool_calls` rows. Journal rows are deleted once a task is no longer running or paused.

### Provider, model, and duration

`task_write` with `action: "create"` accepts optional `provider`, `model`, `thinking_level` and `max_duration_minutes`:

- **`provider` + `model`** flow through the same resolver used for chat (`resolveProviderModelInput`). A bare `model: "kimi-k2.6"` auto-detects the provider when there's a unique match. When neither is set, the configured task default applies. The parameter descriptions of `task_write` and `schedule_write` instruct the agent to **autonomously choose** an appropriate model based on the descriptions in the system prompt's [`<available_providers>` block](./system-prompt#available-providers-configured-llm-providers) — preferring cost-effective models for simple work and stronger models for complex coding or research. The agent only needs to pass these parameters when it has a specific reason to deviate from the default task model.
- **`max_duration_minutes`** is hard-capped at the system maximum from Settings → Tasks → [Max duration](./../settings/tasks#max-duration). Hitting the cap aborts the task as `failed`, not `paused`.
- **`thinking_level`** (`off` … `max`) sets the task agent's reasoning effort. Omitted, the task uses the [background thinking level](./../settings/tasks#background-thinking-level). The `<available_providers>` block lists which levels each model supports and the current background level, so the agent can raise the effort for hard work or lower it for mechanical work. An unsupported level is rounded to the nearest supported one when the task starts.

Each task row stores the requested level (`thinking_level`, `NULL` = background default) and the level it actually ran with (`effective_thinking_level`). The tool result, `task_read`, and the Tasks page show both. A task keeps its level when it is resumed, recovered after a restart, or restarted from the Tasks page. Cronjobs store their own `thinking_level` (set via `schedule_write` or the cronjob form); `schedule_write` with `action: "edit"` and `thinking_level: "default"` resets it.

The flag `is_default_model` records whether the resulting `(provider, model)` pair came from the system default or was explicitly pinned — useful when you change the default later and want to know which historical tasks were on the old default.

Task creation also accepts [`attached_skills`](#attached-skills) — the same mechanism cronjobs use, applied once at spawn time. Because a one-off task has no schedule row to persist the selection in, the resolved `SKILL.md` contents are injected when the task starts and are not stored on the `tasks` row; restarting a task from the Tasks page therefore starts it without attached skills.

### Long-running tasks and context compaction

Tasks have no user who could start a fresh session, so long tool loops are compacted automatically: when the context approaches the model's context window, older turns are replaced by a structured summary and the task continues. Side-effecting actions it already performed (emails, pushes, created tasks, …) are listed deterministically in that summary so they are not repeated. If the provider still reports a context overflow, the task compacts and retries once, then fails with a clear error. Details: [Context Compaction](./compaction).

### Loop detection, status updates, killing

These are operational safeguards documented in detail under [Settings → Tasks](./../settings/tasks). Briefly:

- **Loop detection** (`systematic` / `smart` / `auto`) terminates a task that keeps repeating the same failing tool call (`systematic`) or that an LLM judge considers stuck (`smart`). On detection, the runner aborts the agent, marks the task `failed`, and emits a `<task_injection>` with a `Hint: Use /kill_task <id>` line.
- **Periodic status updates** are opt-in `<task_status type="periodic_update">` messages emitted every N minutes while a task runs. They're persisted as `system`-role rows with a `task_status_update` metadata tag so they don't count as conversational turns, and they're broadcast over WebSocket and (optionally) Telegram. They never invoke the LLM.
- **Killing** a task — from the Tasks page, the API (`POST /api/tasks/:id/kill`), the chat (`/stop` / `/kill`), or the Telegram `/stop` / `/kill` commands — aborts the agent and marks the task `failed`.

## Cronjobs

A **cronjob** is a recurring scheduled entry in the `scheduled_tasks` table. The agent manages cronjobs and reminders with the same two tools — `schedule_read` and `schedule_write` — and picks the flavor with `type`:

- **`type: "task"`** *(default, stored as `action_type: "task"`)* — on each tick, spawns a full task agent with the configured prompt. Use this whenever the action needs to think, fetch fresh data, use tools/skills, or produce a fresh result.
- **`type: "reminder"`** *(stored as `action_type: "injection"`)* — on each tick, delivers the configured prompt verbatim into the parent chat as a system message. No agent runs. Use this only for genuinely static notifications (see [Reminders](#reminders) below).

### The scheduler

The [`TaskScheduler`](https://github.com/meteyou/axiom/blob/main/packages/core/src/task-scheduler.ts) holds the loop. On `start()` it loads every enabled row from `scheduled_tasks` and arms a `setTimeout` for each one's next firing time. There are three subtleties worth knowing about:

- **24-hour wake-up cap.** Node's `setTimeout` overflows at ~24.8 days and fires immediately. The scheduler caps each timer at 24h and re-evaluates from disk on wake-up — so a cronjob set to fire in 90 days actually arms 90 short timers in sequence, each one re-reading the row in case it was disabled or edited in between.
- **55-second deduplication cooldown.** If the scheduler fires a job whose `last_run_at` is less than 55 seconds ago — typically because the server restarted within the same cron minute — the firing is skipped. Without this, `nodemon`-style watch reloads or container restarts would double-fire jobs that had just run.
- **5-second past-due grace.** If the calculated next-run time is more than 5 seconds in the past at startup (e.g. the host was offline through a scheduled tick), that tick is *skipped*, not fired retroactively. Cronjobs are best-effort; missed runs do not stack up.

When a `task`-type cronjob fires, the scheduler creates a `tasks` row with `trigger_type: 'cronjob'` and `trigger_source_id: <cronjob id>`, then hands it to the same `TaskRunner` that handles user/agent-initiated tasks. `last_run_at`, `last_run_task_id`, and `last_run_status` on the `scheduled_tasks` row are updated as the task progresses, so the UI and `schedule_read` always show the most recent run.

### Cron expressions

Standard 5-field cron format: `minute hour day-of-month month day-of-week`. Day-of-week: `0` or `7` = Sunday, `1` = Monday … `6` = Saturday. Steps (`*/15`), ranges (`1-5`), and lists (`8,20`) are all supported. The full grammar is in [`packages/core/src/cron-parser.ts`](https://github.com/meteyou/axiom/blob/main/packages/core/src/cron-parser.ts).

| Natural language | Cron |
|---|---|
| Every day at 9:00 | `0 9 * * *` |
| Every weekday at 14:30 | `30 14 * * 1-5` |
| Every Monday at 8:00 | `0 8 * * 1` |
| Every 15 minutes | `*/15 * * * *` |
| Every hour on the hour | `0 * * * *` |
| First of the month at midnight | `0 0 1 * *` |
| Twice a day (8 and 20) | `0 8,20 * * *` |
| March 30 at 11:30 | `30 11 30 3 *` |

Schedules are evaluated in the **owner's effective timezone**: the owner's own timezone from Settings → Agent, or the global (admin) timezone when they use the default. `0 7 * * *` therefore means 07:00 on the owner's wall clock, also across daylight-saving changes. Wall-clock times skipped by a spring-forward gap do not run that day; times repeated by a fall-back run once. When the owner (or, for the global default, the admin) changes the timezone, all affected enabled cronjobs and reminders are rescheduled immediately. There is no per-cronjob timezone override.

### Auto-disable for one-shot patterns

A specific date/time cron like `30 11 30 3 *` ("March 30 at 11:30") fires every year. To prevent recurring "one-time" reminders, the scheduler applies a heuristic after every `injection` firing: if the next computed run time is more than 364 days away, the row is auto-disabled. Same logic on a cron that has no future run at all (e.g. a date that never matches). `task`-type cronjobs are *not* auto-disabled — they're assumed to be intentional.

### `attached_skills`

`task_write` (`action: "create"`) and `schedule_write` (`type: "task"`, `action: "create"` or `"edit"`) accept an optional `attached_skills` array — names of agent skills under `/data/skills_agent/<name>/` (or installed user skills as `owner/name`). Before the task agent starts, the runner reads each `SKILL.md` and concatenates them into the task's system prompt under an `<attached_skills>` block. For cronjobs this happens on every firing; for a one-off task it happens once, at creation time.

Both tools go through the same helpers in [`packages/core/src/attached-skills.ts`](https://github.com/meteyou/axiom/blob/main/packages/core/src/attached-skills.ts), so resolution, normalization (trim, de-duplicate, drop empties), and error handling are identical.

This is the deterministic alternative to relying on the agent's routing decision. Use it when:

- The run's reliability depends on a skill (e.g. a daily Nitter scrape that needs the `nitter` skill's URL conventions). Without `attached_skills`, the task agent might or might not route to the skill on a given run; with it, the skill rules are guaranteed to be in the prompt.
- You want skill rules baked in at *authoring time*, so future edits to the cronjob don't drift from what the user originally agreed to.

Missing `SKILL.md` files are skipped with a console warning — the task still runs. Pass `attached_skills: []` to `schedule_write` with `action: "edit"` to clear a cronjob's list.

One difference between the two: a cronjob stores its list in `scheduled_tasks.attached_skills`, so every firing re-reads the current `SKILL.md`. A one-off task resolves the list at spawn time only and does not persist it.

### Persistent state across runs (continuity)

Every `task`-type cronjob firing spawns a fresh, isolated task agent with no chat history and no memory of previous runs (see [Isolation](#isolation)). Run N+1 knows nothing about what run N did. For digest, monitor, and watch jobs this is a problem: without any shared state the job re-reports the same items on every tick.

Axiom does not solve this with a platform feature. There is no run-result injection or dedupe flag on `scheduled_tasks`. Instead, continuity is a prompt-level pattern that reuses tools the task agent already has. The cronjob prompt names a fixed "brain" file that the task reads at the start of the run (what is already known or reported) and updates at the end (new facts, last-seen markers). The job dedupes against its own state.

There are two places to keep that state, and the choice matters:

- **`/data/memory/state/<job-name>.json` or `.md`** holds compact, machine-readable job state such as last-seen IDs, timestamps, or cursors. This is the right place for pure dedupe markers.
- **A wiki page** (`/data/memory/wiki/<topic>.md`) holds curated, human-readable knowledge that the job enriches over time. The daily social-media digest that appends facts to a wiki page is an example of this pattern already in use.

This approach needs no code, follows the same file conventions as the rest of the [memory system](./memory), and composes with `attached_skills`: attached skills bake in the rules a run must follow, while the brain file carries the state from one run to the next.

#### Keeping the brain file bounded

A state file that a cronjob writes to on every run grows unnoticed, and that growth has a sharp failure mode. Loading an oversized file can silently exhaust the run's token budget and terminate it. In one real incident a hub page grew to 756 KB and killed the run on a low token budget at high cost. `file_read` now returns at most 2000 lines or 50 KB per call, but an agent that pages through the whole file with `offset` still pays for every chunk. Three habits keep this safe:

1. **Set a size budget** for the file, on the order of 60 KB. When it outgrows the budget, move raw material into monthly archives or sub-pages and keep only a compact summary or the current state in the main file.
2. **Do not blindly load a large state file.** Instead of `file_read` on the whole file, `grep` for the specific marker you need and append new entries with a shell redirect (`>>`).
3. **Keep the split clean.** Compact machine state belongs in `/data/memory/state/`; curated knowledge belongs in the wiki.

### Editing, listing, removing

The agent operates on cronjobs and reminders through two tools, both in [`packages/core/src/schedule-tools.ts`](https://github.com/meteyou/axiom/blob/main/packages/core/src/schedule-tools.ts):

- **`schedule_read`**
  - `action: "list"` — overview with id, name, type, schedule, status, last run, and the next N upcoming run times.
  - `action: "get"` — full configuration of one schedule *including the complete prompt*. The agent is told to call this before editing — never edit a prompt blind.
- **`schedule_write`**
  - `action: "create"` — the constructor (`name`, `prompt`, `schedule`, optional `type`).
  - `action: "edit"` — partial update. Only the fields you pass are changed. Re-registers the timer with the scheduler.
  - `action: "remove"` — deletes the row and cancels the timer.

The web UI (Cronjobs page) is a thin wrapper around the same operations on the `scheduled_tasks` table, so an agent edit and a UI edit are interchangeable.

## Reminders

A **reminder** is *"deliver this static text at this time"*. Internally it's a `scheduled_tasks` row with `action_type: "injection"` — the same machinery as a cronjob. The agent creates one with `schedule_write` (`action: "create"`, `type: "reminder"`), and the `prompt` is the exact message you receive. Two rules keep reminders honest:

- **No agent parameters.** `provider`, `model`, `thinking_level` and `attached_skills` are rejected for `type: "reminder"`, because a reminder runs no agent.
- **Anti-misuse enforcement.** Requests that look dynamic are rejected (see below).

### The anti-misuse heuristic

A reminder delivers static text *verbatim*. No agent runs, no tools execute, no skills load, no fresh data is fetched. So `schedule_write` runs every reminder — on create, and on edit when the type becomes `reminder` or the prompt changes — through `looksLikeDynamicTaskRequest` (in `schedule-tools.ts`), which scans the `name` and `prompt` for patterns like *"current"*, *"latest"*, *"check"*, *"verify"*, *"weather"*, *"forecast"*, *"summarize"*, *"use skill"*, etc. — both English and German. If any pattern matches, the call returns:

> Error: type "reminder" only supports static text delivered verbatim. This request looks dynamic (for example checking current data, using a skill/tool, or doing work at run time). Use schedule_write with type "task" instead.

The heuristic is deliberately blunt — false positives are fine because the alternative (a `task`-type cronjob) is strictly more capable. The contract is: *if you genuinely just want a string delivered later, use `type: "reminder"`; otherwise use `type: "task"`*.

### One-shot semantics

There's no separate "fires once" mode in cron. To get a one-shot reminder, use a cron expression that matches a single point in time:

```text
30 11 30 3 *   # March 30 at 11:30
0  9  *  *  4  # Every Thursday at 9 (cron has no "tomorrow")
```

For exact-once delivery on a non-recurring date, the standard pattern is `<minute> <hour> <day> <month> *`. Because the next match after firing is more than 364 days away, the [auto-disable heuristic](#auto-disable-for-one-shot-patterns) kicks in and disables the row after the first run — no manual cleanup needed.

### Delivery

When a reminder fires, the `onInjection` callback (wired up by the runtime composer) inserts the message into the parent session as a system message and broadcasts to all connected channels — web chat and Telegram. The reminder row's `last_run_at` and `last_run_status` are updated to `completed`. Unlike a `task`-type firing, no `tasks` row is created and no agent is invoked.

## Safety: never use OS-level schedulers

A hard rule, also part of the hard-coded [`<system_rules>`](./system-prompt#system-rules-hard-coded-rules) of every chat and task prompt:

> **Never use OS-level schedulers.** No `crontab`, no `launchd`, no `at`, no shell-spawned long-running processes (`nohup`, `&`, background loops). Always use the built-in tools.

OS-level schedulers don't survive container restarts, can't be inspected from the UI, bypass the scheduler's deduplication and timezone handling, escape provider routing entirely, and produce no audit trail in the `tasks` / `scheduled_tasks` tables. The temptation to fall back to `crontab` when a cron expression looks awkward is real — resist it. Anything you can't express with the 5-field grammar above almost certainly belongs in a `task`-type cronjob whose prompt does the conditional logic.

## See also

- [System Prompt → `<system_rules>`](./system-prompt#system-rules-hard-coded-rules) — where the task-injection trigger and the OS-scheduler safety rule are injected.
- [Skills](./skills) — the skill registry, including the `tasks-and-cronjobs` built-in skill that carries the agent-facing usage guide.
- [Settings → Tasks](./../settings/tasks) — defaults for provider, max duration, telegram delivery, loop detection, status updates, and background thinking level.
- [Built-in Tools → Tasks, cronjobs & reminders](./tools#tasks-cronjobs-reminders) — short description of every task/cronjob/reminder tool.
- [Memory System](./memory) — the parent session and chat history that task results are written into.
