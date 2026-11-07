---
name: tasks-and-cronjobs
version: 1.4.0
description: Use Axiom's background-execution system — one-off background tasks (task_write, task_read), recurring cronjobs and static scheduled reminders (schedule_write, schedule_read). Load this skill before creating any of them, and ALWAYS load it when you receive a <task_injection> message so you respond correctly.
---

# Tasks, Cronjobs & Reminders

Axiom has three related but distinct ways to run work outside the current chat turn. Picking the right one is the most important decision — they look similar but behave very differently.

| Tool family | Lifecycle | Spawns an agent? | Typical use |
|---|---|---|---|
| **Tasks** (`task_write`, `task_read`) | One-shot, async | **Yes** — full agent with all tools/skills, plus optional `attached_skills` | "Build this app." "Refactor X across the repo." "Research and write a report." |
| **Cronjobs** (`schedule_write` with `type: "task"`, `schedule_read`) | Recurring on a cron schedule | **Yes** — full agent on every run | "Every weekday at 9 summarize my GitHub notifications." "Daily sanity check on service X." |
| **Reminders** (`schedule_write` with `type: "reminder"`) | Scheduled, can be one-shot or recurring | **No — static text only** | "Remind me at 17:30 to leave for the train." "Every Monday morning ping me 'standup at 10'." |

Schedules are managed with two tools: `schedule_read` (actions `list`, `get`) and `schedule_write` (actions `create`, `edit`, `remove`; `type` is `task` or `reminder`). Fields the action needs but you omit are reported back as an error, e.g. `schedule is required for action=create`.

## The decision flow (read this first)

When the user asks for "scheduled" or "background" work, choose like this:

```
Does the user want it to run AT A SPECIFIC TIME or ON A SCHEDULE?
├── No  → It's a Task. Use task_write with action "create". (Async one-shot.)
└── Yes → Does the action need to think, fetch fresh data, use tools/skills,
          analyze, or produce a fresh result at run time?
          ├── Yes → schedule_write action "create", type "task" (default).
          └── No, just deliver some static text (one-shot or recurring)
              → schedule_write action "create", type "reminder".
```

**Rule of thumb**: when in doubt, choose the more powerful option. `type: "task"` can do anything `type: "reminder"` can; the reverse is not true. A reminder is refused anyway if it looks dynamic (see [Reminder anti-misuse](#reminder-anti-misuse) below).

---

## Tasks

A task is a self-contained agent run that proceeds in the background. You hand off a prompt and continue helping the user; when the task finishes, fails, or has a question, you receive a `<task_injection>` message in the next turn (see [Handling task injections](#handling-task-injections)).

### When to spawn a task

- Complex coding work (building apps, multi-file refactors, new features).
- Long research or analysis where you'd otherwise stall the chat.
- Anything the user explicitly says to "do in the background" or "while we keep talking".
- Work that will outlive the current chat exchange.

### When NOT to spawn a task

- Simple questions you can answer directly.
- Small edits or checks you can finish in this turn.
- Anything that needs immediate back-and-forth — tasks run isolated, not in dialogue.
- "Just to be safe, I'll spawn a task" — no. The token and time cost is real.

### Writing a good task prompt

The task agent runs in **isolation** — no chat history, no recall of context, no follow-up unless it asks via `status: question`. Write the prompt so a fresh agent could execute it cold:

- **Goal in one sentence** at the top: *"Add a dark-mode toggle to the settings page."*
- **Constraints** the agent must respect: file boundaries, libraries to use/avoid, code style.
- **Concrete inputs**: file paths (absolute), URLs, tickets, IDs. Quote them inline.
- **Definition of done**: a concrete, checkable finish line, not an activity. *"Done means every endpoint uses the new client, the old client is deleted, and the test suite passes"* beats *"work on the migration"*. Without it, strong models tend to stop early (after the first phase) or report progress instead of finishing.
- **Verification expectations**: how the agent proves it's done (tests pass, build succeeds, screenshot, `gh pr view` after opening a PR). A completion claim is not evidence; ask for the evidence.
- **Pre-granted permissions**: name the risky-looking but required steps up front (copying env vars, pushing to a branch, installing a dependency). Otherwise the task may pause with `status: question` just to ask for permission you already intended to give.
- **Explicit exclusions**: say what the task must *not* do (no force-push, no changes outside the repo, no merge, no public posts). Exclusions steer more reliably than general intent.
- **When to stop and ask**: give the agent a legitimate way out, e.g. *"Keep going without asking unless you cannot continue without me, or before anything destructive. If something fails for a reason you can't explain, stop and ask."* Models are trained hard not to give up; without this sentence they answer their own questions and push through a wrong path.
- **Final deliverable**: what the final report must contain (file diff summary, links, numbers). For long tasks, require a fixed closing structure, e.g. three headings **Blocked on me / Changed / Found**, plus a list of anything the agent could **not** verify.

If you'd need to say *"and remember from earlier we decided…"*, include that decision verbatim in the prompt. The task can't read the chat.

Skip filler instructions like *"think carefully"* or *"think step by step"*: current models reason on their own, and it only adds noise. If the work splits naturally (large audits, many independent reviews, a migration across many files), explicitly allow parallel sub-agents; some models rarely use them unprompted.

Template:

```
Goal: <one sentence>.
Context: <paths, IDs, decisions from the chat, verbatim>.
Done means: <checkable end state>.
Verify by: <tests / build / screenshot / API check>.
You may: <pre-granted permissions>.
Do not: <exclusions>.
Keep going without asking; stop and ask only if <condition> or before anything destructive.
Final report: Blocked on me / Changed / Found, plus anything you could not verify.
```

### Provider and model selection

`task_write` (action `create`) and `schedule_write` (type `task`) accept optional `provider` and `model`. Defaults come from **Settings → Tasks**.

- Pass `model` only when the user **explicitly** names one ("run this with kimi-k2.6"). The provider is auto-detected from `<available_providers>` if unique.
- Pass `provider` + `model` together to pin both.
- Otherwise omit both — the default task provider is used.

### `thinking_level`

`task_write` (action `create`) and `schedule_write` (type `task`, actions `create` and `edit`) accept an optional `thinking_level` (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`). Omit it to use the background thinking level from **Settings → Tasks** (the current value is shown in `<available_providers>`).

- `<available_providers>` lists the levels each model supports (`thinking: off, low, high, …`). Pick one from that list — unsupported levels are rounded to the nearest supported one.
- Raise it for hard reasoning, planning or complex coding; lower it (or `off`) for simple, mechanical work like fetching and reformatting. Honour an explicit user request ("think hard about this").
- `schedule_write` action `edit` with `thinking_level: "default"` resets a cronjob to the background level.
- The tool result and `task_read` report the level the task actually runs with.

### `max_duration_minutes`

Optional cap. Defaults to the system value, hard-capped at the system maximum (set in Settings → Tasks). Only set this when the user wants something different. Tasks that hit the cap are aborted, not paused.

### `attached_skills`

`task_write` (action `create`) takes an optional `attached_skills` array — names of agent skills under `/data/skills_agent/<name>/` (or installed skills as `owner/name`). Each `SKILL.md` is **injected directly into the task prompt** when the task starts, so the task agent doesn't have to discover and `file_read` the skill itself.

```
task_write(
  action: "create",
  name: "Nitter scrape",
  prompt: "<self-contained instructions>",
  attached_skills: ["nitter"],
)
```

Use it whenever the task's work depends on a skill — it is more reliable than writing "read /data/skills_agent/nitter/SKILL.md first" into the prompt. Missing SKILL.md files are skipped with a warning; the task still runs. Omit the parameter when no skill is relevant.

### Resuming a paused task

When a task pauses with `status: question`, it's waiting for input via `task_write` with action `resume`. See the next section.

---

## Handling task injections

When a background task completes, fails, or has a question, the next message you receive contains a `<task_injection>` block:

```xml
<task_injection task_id="..." task_name="..." status="completed|failed|question"
  trigger="user|agent|cronjob" duration_minutes="..." tokens_used="...">
Summary text from the task agent
</task_injection>
```

**Always reply naturally to the user.** Do not echo the raw block. Translate the content into a normal conversational message:

| Status | What to say |
|---|---|
| `completed` | Tell the user what got done. Include concrete details: files created/modified, verification performed, links, numbers. Don't bury the lede. Lead with anything the task says it is **blocked on** or needs from the user. If the task claims an external effect (PR opened, commit pushed, file written) and the summary gives no evidence, verify it cheaply yourself before repeating the claim. |
| `failed` | Explain what went wrong in plain language. If actionable, suggest a next step (retry with different inputs, fix the missing dependency, …). Don't pretend it succeeded. |
| `question` | Relay the question to the user naturally. The task is **paused** waiting for an answer — do not start solving it yourself. |

### Routing follow-up answers to a paused task

When you've relayed a `question` to the user and they reply, you almost always need to forward that reply back into the paused task with `task_write` (action `resume`):

1. **Decide whether the user's reply is for the paused task.** Usually yes (they're answering the question you just relayed). If clearly off-topic (new request, unrelated comment), handle it in chat instead.
2. **Call `task_write` with action `resume`**, the `task_id` from the injection and a `message` containing the user's answer plus any context the task needs (e.g. the original question, conversation snippets that clarify, file paths that came up). Don't just forward the raw user text — the task has no chat history.
3. The task resumes in the background. The next `<task_injection>` arrives when it's done or has another question.

If multiple tasks are paused (rare), pick the one whose question matches the user's reply. When unclear, ask the user which task they're answering.

---

## Cronjobs

A cronjob (`schedule_write` with `type: "task"`, the default) runs on a recurring schedule and spawns a full agent on each run, with access to all tools and skills. Use it for anything dynamic.

Periodic notifications with **no** computation are reminders (`type: "reminder"`, see [Reminders](#reminders)). If unsure → **task**.

### Cron expression cheat sheet

5 standard fields: `minute hour day-of-month month day-of-week`. Day-of-week: `0` or `7` = Sunday, `1` = Monday … `6` = Saturday.

| Natural language | Cron |
|---|---|
| Every day at 9:00 | `0 9 * * *` |
| Every weekday at 14:30 | `30 14 * * 1-5` |
| Every Monday at 8:00 | `0 8 * * 1` |
| Every 15 minutes | `*/15 * * * *` |
| Every hour on the hour | `0 * * * *` |
| First of the month at midnight | `0 0 1 * *` |
| Twice a day (8 and 20) | `0 8,20 * * *` |
| March 30 at 11:30 (one-shot) | `30 11 30 3 *` |

Schedules are evaluated in the user's timezone (see `<current_time>` on each message). Confirm the user's intended timezone if it's unclear from context.

### `attached_skills`

`schedule_write` (actions `create` and `edit`) takes the same optional `attached_skills` array as `task_write`. The contents of each `SKILL.md` get **injected directly into the task prompt** on every run, so the spawned task agent doesn't have to discover and `file_read` the skill itself. Only for `type: "task"`; reminders reject it.

Use this when:
- The cronjob's reliability depends on a skill (e.g. a daily Nitter scrape that needs the `nitter` skill's URL conventions).
- You want the skill rules to be deterministic, not subject to routing decisions.

```
attached_skills: ["nitter", "summarizer"]
```

Missing SKILL.md files are skipped with a warning — the task still runs.

### Persistent state across runs (continuity)

Each cronjob run spawns a **fresh, isolated task agent**. Run N+1 remembers nothing from run N. For digest / monitor / watch jobs this means the same items get reported over and over. Fix it with a **brain file** the task owns:

1. At the **start** of the run, read the brain file to see what's already known/reported.
2. Do the work, dedupe against that state.
3. At the **end**, write the new facts / last-seen markers back.

This needs zero platform code — it's just `file_read` / `file_write` in the cronjob prompt. It composes with `attached_skills`: attached skills bake in *rules*, the brain file carries *run-to-run state*.

**Where to store:**

- **`/data/memory/state/<job-name>.json` or `.md`** — compact, machine-readable job state (last-seen IDs, timestamps, cursors). Prefer this for pure dedupe markers.
- **Wiki page (`/data/memory/wiki/<topic>.md`)** — curated, human-readable knowledge the job enriches over time.

**Guardrails (a brain a cronjob writes to on every run grows unnoticed):**

- **Set a size budget** (~60 KB). When the file outgrows it, move raw material into monthly archives / sub-pages and keep only a compact summary or current state in the main file.
- **Don't blindly `file_read` a large state file** — a single `file_read` on an overgrown file can silently blow up the run (a real incident: a hub page grew to 756 KB and killed the run on low token budget / high cost). Instead `grep` for the specific marker and append with shell `>>`.
- **Keep the split clean:** compact machine state → `/data/memory/state/`; curated knowledge → the wiki.

Example digest cronjob prompt using a brain file:

```
prompt: "Read /data/memory/state/hn-digest.md for the list of story IDs already sent.
         Fetch the current Hacker News front page. Report only stories whose ID is
         NOT in that file, as a 5-bullet digest. Then append the newly reported IDs
         to /data/memory/state/hn-digest.md (use grep + shell append, do not reload
         the whole file if it is large). Keep the file under ~60 KB."
```

### Editing, listing, removing

- `schedule_read` action `list` — overview of all cronjobs and reminders (id, name, schedule, type, status, next runs).
- `schedule_read` action `get` (`id`) — full configuration of one schedule, **including the complete prompt**. Use this before editing — never edit a prompt blind.
- `schedule_write` action `edit` (`id`) — partial update; only fields you pass are changed. Pass only `enabled` to toggle it, `attached_skills: []` to clear all attached skills, `thinking_level: "default"` to reset the thinking level.
- `schedule_write` action `remove` (`id`) — deletes the schedule. Confirm with the user first if it wasn't created in this conversation.

---

## Reminders

`schedule_write` with action `create` and `type: "reminder"` schedules a **static text** to be delivered verbatim into the chat at a future time. No agent runs, no tools execute, no skills load, no fresh data is fetched. Just text. `provider`, `model`, `thinking_level` and `attached_skills` are rejected for reminders.

### When to use it

- "Remind me at 17:30 to leave for the train."
- "Every weekday at 8:55 ping me: 'standup in 5'."
- "Tell me on March 30 at 11:30 that the package is being delivered."

The `prompt` is the literal text the user will see. Write it from the user's perspective ("Time to leave for the train", not "User wants to be reminded about the train").

### One-shot reminders

There's no separate "fires once" mode — use a cron expression that matches a single point in time:

| Natural language | Cron | Notes |
|---|---|---|
| March 30 at 11:30 | `30 11 30 3 *` | Will fire annually on March 30. For truly one-shot, remove it after the first run, or use a year-specific tool. |
| Tomorrow at 9 (assume today is Wed) | `0 9 * * 4` | Day-of-week is loose — fires every Thursday. Use day-of-month for precision. |

For exact-once delivery on a non-recurring date, the cleanest pattern is `<minute> <hour> <day> <month> *` — it fires once this year. If recurrence is unwanted, either remove the cronjob after firing or warn the user it will recur.

### Reminder anti-misuse {#reminder-anti-misuse}

`type: "reminder"` rejects requests that look dynamic — anything matching keywords like *"current"*, *"check"*, *"weather"*, *"latest"*, *"summarize"*, *"use skill"*, etc. The error message points you to `type: "task"`. **Don't try to evade the check by rephrasing.** If the user wants the reminder text to be computed at run time, you genuinely need a task-type cronjob.

---

## Common patterns

### "Run this in the background"

```
task_write(
  action: "create",
  name: "Refactor settings page",
  prompt: "<self-contained instructions>",
)
```

### "Run this in the background, following the wiki skill"

```
task_write(
  action: "create",
  name: "Wiki cleanup",
  prompt: "<self-contained instructions>",
  attached_skills: ["wiki"],   // SKILL.md baked into the task prompt
)
```

### "Every weekday morning, summarize my GitHub notifications"

```
schedule_write(
  action: "create",
  type: "task",                 // explicit, since this needs to fetch
  name: "GitHub morning digest",
  schedule: "0 9 * * 1-5",
  prompt: "Fetch GitHub notifications via the GitHub API and produce a 5-bullet digest. Group by repo. Highlight anything mentioning me. Deliver the digest as the final message.",
)
```

### "Ping me every hour with my todo list"

If the text is static and never changes wording → `type: "reminder"`. If the list has to be read or regenerated each time → `type: "task"`.

### "Remind me at 17:30 to leave"

```
schedule_write(
  action: "create",
  type: "reminder",
  name: "Train reminder",
  schedule: "30 17 * * *",
  prompt: "Time to leave for the train.",
)
```

### "Daily Nitter scrape with the nitter skill rules"

```
schedule_write(
  action: "create",
  type: "task",
  name: "Nitter daily scrape",
  schedule: "0 7 * * *",
  prompt: "Scrape the configured Nitter accounts and append new posts to /data/memory/wiki/social.md following the conventions.",
  attached_skills: ["nitter"],   // SKILL.md baked into the prompt
)
```

### "A daily digest that doesn't repeat itself"

Give the cronjob a brain file so it dedupes across runs (see [Persistent state across runs](#persistent-state-across-runs-continuity)):

```
schedule_write(
  action: "create",
  type: "task",
  name: "HN digest",
  schedule: "0 8 * * *",
  prompt: "Read /data/memory/state/hn-digest.md for story IDs already sent. Fetch the HN front page, report only new stories, then append the new IDs back to that file (grep + shell append; keep it under ~60 KB).",
)
```

---

## Common mistakes to avoid

- **Spawning a task for a question you can answer directly.** Wastes tokens and time.
- **A task prompt without a definition of done.** The task stops after the first step or returns a plan instead of results. State the checkable end state.
- **Telling a task to "think hard".** It doesn't help and costs tokens. Describe the goal and the finish line instead.
- **Reminder for dynamic content.** "Remind me each morning what the weather is" → that's `type: "task"`, not a reminder.
- **Editing a cronjob's prompt without first calling `schedule_read` action `get`.** You'll either overwrite something important or repeat a typo. Read first, then edit.
- **Forgetting timezone.** Cron schedules use the configured `TZ`. If the user is in a different timezone, ask before assuming.
- **Forwarding raw user text to `task_write` (action `resume`) without context.** The paused task has no chat history. Include the question + the user's answer + any relevant context in the `message`.
- **Promising fresh data from a reminder.** A reminder is static text. If you say "I'll remind you with the latest weather", you're lying. Use `type: "task"` instead.
- **Telling a task to `file_read` a skill instead of attaching it.** `task_write` accepts `attached_skills` — use it, the SKILL.md then ships inside the task prompt.
- **Attaching skills to a reminder.** No agent runs there, so `attached_skills` is rejected for `type: "reminder"`.
- **A digest/monitor cronjob with no brain file.** Each run is isolated, so it re-reports the same items forever. Give it a `/data/memory/state/` file to dedupe against.
- **Reloading an overgrown brain file with `file_read`.** A single `file_read` on a state/wiki file that grew into the hundreds of KB can kill the run. Budget its size and `grep` + append instead.

---

## Hard rules (also enforced in the system prompt)

- **NEVER use OS-level schedulers.** No `crontab`, no `launchd`, no `at`, no shell-spawned long-running processes (`nohup`, `&`, background loops). Always use the built-in tools above. The OS-level versions don't survive container restarts, can't be inspected from the UI, and bypass logging and provider routing entirely.
- **NEVER claim a reminder will fetch fresh data.** Only `type: "task"` schedules run an agent.

---

## Tools reference

| Tool | What it does |
|---|---|
| `task_read` | List background tasks with their status, filterable by status and trigger type. |
| `task_write` | `create`: spawn a one-shot background agent with a self-contained prompt; optional `attached_skills` bakes the listed SKILL.md files into the task prompt, optional `thinking_level` sets the reasoning effort. `resume`: send a `message` to a paused task (used after a `status: question` injection). `stop`: cancel a running task (own tasks; admins any task). |
| `schedule_read` | `list`: all cronjobs and reminders (id, name, schedule, type, status). `get`: full configuration of one schedule, including the full prompt. Use before editing. |
| `schedule_write` | `create`: schedule a cronjob (`type: "task"`) or a static reminder (`type: "reminder"`). `edit`: partial update (prompt, name, schedule, type, provider/model, thinking_level, enabled, attached_skills). `remove`: delete a schedule. |
