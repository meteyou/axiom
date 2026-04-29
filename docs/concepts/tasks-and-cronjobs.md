# Tasks & Cronjobs

Axiom has three related but distinct ways to run work *outside the current chat turn*: **tasks** (one-shot background runs), **cronjobs** (recurring scheduled runs), and **reminders** (one-shot scheduled text). They share the same underlying machinery — a SQLite-backed scheduler, a `TaskRunner` that spawns isolated agents, and a notification layer that funnels results back into the right chat session — but they're meant for different kinds of work.

| | **Tasks** | **Cronjobs** | **Reminders** |
|---|---|---|---|
| Trigger | Fire-and-forget, on demand | Recurring on a 5-field cron schedule | One-shot at a future time |
| Spawns an agent? | Always | Only when `action_type: "task"` | Never — static text |
| Tools / skills available? | Full registry | Full registry (task type only) | None |
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

Paused agents that nobody resumes are garbage-collected after a stale-cleanup interval; their database row stays as `paused` but the in-memory agent is gone, so calling `resume_task` on them returns *"agent is no longer in memory"*.

### Isolation

Every task runs in its own agent instance with its own session ID — separate from the parent chat. A task agent has:

- **No chat history.** It cannot read what was said in the conversation that triggered it. Anything it needs has to be in the `prompt` field.
- **A different system prompt.** Built by [`buildTaskSystemPrompt`](https://github.com/meteyou/axiom/blob/main/packages/core/src/task-runner.ts) — it tells the agent *"You are a background task agent. You are NOT a chatbot — you are an autonomous worker"*, points at `/workspace`, and enforces the `STATUS: … / SUMMARY: …` final-message format described below.
- **The full toolset and skill index.** Same `<available_tools>` and `<available_skills>` as a chat agent. Cronjobs can additionally pin specific skills via `attached_skills` (see below).
- **A fresh provider/model session.** The task either uses the configured task default provider (Settings → Tasks) or whatever was explicitly pinned at creation time.

### Triggers

The `tasks.trigger_type` column records *who created the task*. There are five trigger types:

| Trigger | Meaning |
|---|---|
| `user` | Manually started from the **Tasks** page in the web UI. |
| `agent` | The chat agent called `create_task` mid-conversation. |
| `cronjob` | A scheduled `action_type: "task"` cronjob fired and spawned this run. |
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

The parent agent's job is to *translate* this into a natural reply — the system prompt's `<task_system>` block (see [System Prompt → layer 14](./system-prompt#_14-task-system-task-and-cronjob-pointer)) tells it to load the `tasks-and-cronjobs` skill before responding, which carries the conventions (don't echo the raw block, route follow-ups via `resume_task`, …).

### Resuming a paused task

When the user replies after a `status="question"` injection, the agent calls [`resume_task(task_id, message)`](https://github.com/meteyou/axiom/blob/main/packages/core/src/task-tools.ts) with the user's answer plus enough context for the task to continue (the original question, any conversation snippets that clarify, file paths that came up — the paused task has no chat history of its own).

`resume_task` validates that:

1. The task exists and is in status `paused`.
2. The agent is still in memory (`pausedTasks` map). If it's been garbage-collected, the call fails with *"agent is no longer in memory. The task may have timed out."*

If both checks pass, the task transitions back to `running` and the next `<task_injection>` arrives when it's done or has another question.

### Provider, model, and duration

`create_task` accepts optional `provider`, `model`, and `max_duration_minutes`:

- **`provider` + `model`** flow through the same resolver used for chat (`resolveProviderModelInput`). A bare `model: "kimi-k2.6"` auto-detects the provider when there's a unique match. When neither is set, the configured task default applies.
- **`max_duration_minutes`** is hard-capped at the system maximum from Settings → Tasks → [Max duration](./../settings/tasks#max-duration). Hitting the cap aborts the task as `failed`, not `paused`.

The flag `is_default_model` records whether the resulting `(provider, model)` pair came from the system default or was explicitly pinned — useful when you change the default later and want to know which historical tasks were on the old default.

### Loop detection, status updates, killing

These are operational safeguards documented in detail under [Settings → Tasks](./../settings/tasks). Briefly:

- **Loop detection** (`systematic` / `smart` / `auto`) terminates a task that's calling the same tool with the same args in circles, or repeatedly failing. On detection, the runner aborts the agent, marks the task `failed`, and emits a `<task_injection>` with a `Hint: Use /kill_task <id>` line.
- **Periodic status updates** are opt-in `<task_status type="periodic_update">` messages emitted every N minutes while a task runs. They're persisted as `system`-role rows with a `task_status_update` metadata tag so they don't count as conversational turns, and they're broadcast over WebSocket and (optionally) Telegram. They never invoke the LLM.
- **Killing** a task — from the Tasks page, the API (`POST /api/tasks/:id/kill`), the chat (`/stop` / `/kill`), or the Telegram `/stop` / `/kill` commands — aborts the agent and marks the task `failed`.

## Cronjobs

A **cronjob** is a recurring scheduled entry in the `scheduled_tasks` table. Two flavors, distinguished by `action_type`:

- **`action_type: "task"`** *(default)* — on each tick, spawns a full task agent with the configured prompt. Use this whenever the action needs to think, fetch fresh data, use tools/skills, or produce a fresh result.
- **`action_type: "injection"`** — on each tick, delivers the configured prompt verbatim into the parent chat as a system message. No agent runs. Use this only for genuinely static periodic notifications.

Internally, a `create_reminder` is just a cronjob with `action_type: "injection"` (see [Reminders](#reminders) below).

### The scheduler

The [`TaskScheduler`](https://github.com/meteyou/axiom/blob/main/packages/core/src/task-scheduler.ts) holds the loop. On `start()` it loads every enabled row from `scheduled_tasks` and arms a `setTimeout` for each one's next firing time. There are three subtleties worth knowing about:

- **24-hour wake-up cap.** Node's `setTimeout` overflows at ~24.8 days and fires immediately. The scheduler caps each timer at 24h and re-evaluates from disk on wake-up — so a cronjob set to fire in 90 days actually arms 90 short timers in sequence, each one re-reading the row in case it was disabled or edited in between.
- **55-second deduplication cooldown.** If the scheduler fires a job whose `last_run_at` is less than 55 seconds ago — typically because the server restarted within the same cron minute — the firing is skipped. Without this, `nodemon`-style watch reloads or container restarts would double-fire jobs that had just run.
- **5-second past-due grace.** If the calculated next-run time is more than 5 seconds in the past at startup (e.g. the host was offline through a scheduled tick), that tick is *skipped*, not fired retroactively. Cronjobs are best-effort; missed runs do not stack up.

When a `task`-type cronjob fires, the scheduler creates a `tasks` row with `trigger_type: 'cronjob'` and `trigger_source_id: <cronjob id>`, then hands it to the same `TaskRunner` that handles user/agent-initiated tasks. `last_run_at`, `last_run_task_id`, and `last_run_status` on the `scheduled_tasks` row are updated as the task progresses, so the UI and `list_cronjobs` always show the most recent run.

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

Schedules are evaluated in the configured `timezone` (see `<current_datetime>` in the system prompt, set via Settings → Agent). If you change the timezone, all enabled cronjobs are reinterpreted on the next tick — there is no per-cronjob timezone override.

### Auto-disable for one-shot patterns

A specific date/time cron like `30 11 30 3 *` ("March 30 at 11:30") fires every year. To prevent recurring "one-time" reminders, the scheduler applies a heuristic after every `injection` firing: if the next computed run time is more than 364 days away, the row is auto-disabled. Same logic on a cron that has no future run at all (e.g. a date that never matches). `task`-type cronjobs are *not* auto-disabled — they're assumed to be intentional.

### `attached_skills`

`create_cronjob` and `edit_cronjob` accept an optional `attached_skills` array — names of agent skills under `/data/skills_agent/<name>/` (or installed user skills). On each firing, the runner reads each `SKILL.md` and concatenates them into the spawned task's system prompt under an `<attached_skills>` block, *before* the task starts.

This is the deterministic alternative to relying on the agent's routing decision. Use it when:

- The cronjob's reliability depends on a skill (e.g. a daily Nitter scrape that needs the `nitter` skill's URL conventions). Without `attached_skills`, the task agent might or might not route to the skill on a given run; with it, the skill rules are guaranteed to be in the prompt.
- You want skill rules baked in at *cronjob authoring time*, so future edits to the cronjob don't drift from what the user originally agreed to.

Missing `SKILL.md` files are skipped with a console warning — the task still runs. Pass `attached_skills: []` to `edit_cronjob` to clear the list.

### Editing, listing, removing

The agent (or the user) operates on cronjobs through five tools, all in [`packages/core/src/cronjob-tools.ts`](https://github.com/meteyou/axiom/blob/main/packages/core/src/cronjob-tools.ts):

- **`list_cronjobs`** — overview with id, name, schedule, status, last run, and the next N upcoming run times.
- **`get_cronjob`** — full configuration of one cronjob *including the complete prompt*. The agent is required to call this before editing — never edit a prompt blind.
- **`edit_cronjob`** — partial update. Only the fields you pass are changed. Re-registers the timer with the scheduler.
- **`remove_cronjob`** — deletes the row and cancels the timer.
- **`create_cronjob`** — the constructor.

The web UI (Cronjobs page) is a thin wrapper around the same operations on the `scheduled_tasks` table, so an agent edit and a UI edit are interchangeable.

## Reminders

A **reminder** is the friendly shortcut for *"deliver this static text at this time"*. Internally it's a `scheduled_tasks` row with `action_type: "injection"` — the same machinery as a cronjob — but exposed as a separate tool (`create_reminder`) with a tighter contract.

### Why a separate tool?

Two reasons:

- **Vocabulary.** When the user says *"remind me at 17:30 to leave for the train"*, calling `create_cronjob` with a buried `action_type: "injection"` would be the wrong shape. A dedicated tool makes the intent explicit and the parameters smaller (`message` instead of `prompt`, no `provider` / `model` / `attached_skills`).
- **Anti-misuse enforcement.** `create_reminder` rejects requests that look dynamic.

### The anti-misuse heuristic

A reminder delivers static text *verbatim*. No agent runs, no tools execute, no skills load, no fresh data is fetched. So `create_reminder` runs every request through `looksLikeDynamicTaskRequest` (in `cronjob-tools.ts`), which scans the `name` and `message` for patterns like *"current"*, *"latest"*, *"check"*, *"verify"*, *"weather"*, *"forecast"*, *"summarize"*, *"use skill"*, etc. — both English and German. If any pattern matches, the call returns:

> Error: `create_reminder` only supports static reminder text delivered verbatim. This request looks dynamic (for example checking current data, using a skill/tool, or doing work at run time). Use `create_cronjob` with `action_type: "task"` instead.

The heuristic is deliberately blunt — false positives are fine because the alternative (a `task`-type cronjob) is strictly more capable. The contract is: *if you genuinely just want a string delivered later, use `create_reminder`; otherwise use `create_cronjob`*.

### One-shot semantics

There's no separate "fires once" mode in cron. To get a one-shot reminder, use a cron expression that matches a single point in time:

```text
30 11 30 3 *   # March 30 at 11:30
0  9  *  *  4  # Every Thursday at 9 (cron has no "tomorrow")
```

For exact-once delivery on a non-recurring date, the standard pattern is `<minute> <hour> <day> <month> *`. Because the next match after firing is more than 364 days away, the [auto-disable heuristic](#auto-disable-for-one-shot-patterns) kicks in and disables the row after the first run — no manual cleanup needed.

### Delivery

When a reminder fires, the `onInjection` callback (wired up by the runtime composer) inserts the `message` into the parent session as a system message and broadcasts to all connected channels — web chat and Telegram. The reminder row's `last_run_at` and `last_run_status` are updated to `completed`. Unlike a `task`-type firing, no `tasks` row is created and no agent is invoked.

## Safety: never use OS-level schedulers

A hard rule, also enforced inline in the system prompt's `<task_system>` block:

> **Never use OS-level schedulers.** No `crontab`, no `launchd`, no `at`, no shell-spawned long-running processes (`nohup`, `&`, background loops). Always use the built-in tools.

OS-level schedulers don't survive container restarts, can't be inspected from the UI, bypass the scheduler's deduplication and timezone handling, escape provider routing entirely, and produce no audit trail in the `tasks` / `scheduled_tasks` tables. The temptation to fall back to `crontab` when a cron expression looks awkward is real — resist it. Anything you can't express with the 5-field grammar above almost certainly belongs in a `task`-type cronjob whose prompt does the conditional logic.

## See also

- [System Prompt → `<task_system>`](./system-prompt#_14-task-system-task-and-cronjob-pointer) — where the task/cronjob pointer and the OS-scheduler safety rule are injected.
- [Skills](./skills) — the skill registry, including the `tasks-and-cronjobs` built-in skill that carries the agent-facing usage guide.
- [Settings → Tasks](./../settings/tasks) — defaults for provider, max duration, telegram delivery, loop detection, status updates, and background thinking level.
- [Built-in Tools → Tasks, cronjobs & reminders](./tools#tasks-cronjobs-reminders) — short description of every task/cronjob/reminder tool.
- [Memory System](./memory) — the parent session and chat history that task results are written into.
