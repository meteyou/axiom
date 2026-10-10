# Codemode

Codemode is an **experimental, off-by-default** tool that lets an agent write a JavaScript script that calls its own tools — in parallel, chained, filtered — so that only the script's output reaches the model.

There are many ways to run tools. This one runs them as a script, and the model only sees what the script returns.

**Where to turn it on:** the **Codemode** section (marked *Experimental* in the UI) under [Settings → Agent](../settings/agent#codemode-experimental) for the chat agent and under [Settings → Tasks](../settings/tasks#codemode-experimental) for background tasks.

## What it changes

Normally every tool call the agent makes costs a round trip: the tool's result flows into the model's context in full, and the model decides what to do next. For bulk work — dozens of emails, many searches, several fetched pages — that is slow and expensive.

With codemode, the agent instead writes one script that does the whole sweep:

```js
// @options: {"max_output_tokens": 1000, "timeout_ms": 120000}
const [status, api] = await Promise.allSettled([
  tools.web_fetch({ url: 'https://status.example.com' }),
  tools.shell({ command: 'curl -sf --max-time 20 https://api.example.com/health' }),
])
const down = []
if (status.status === 'rejected') down.push(`status page: ${status.reason.message}`)
if (api.status === 'rejected') down.push(`api health: ${api.reason.message}`)
else if (api.value.exit_code !== 0) down.push(`api health: exit ${api.value.exit_code} — ${api.value.output}`)
return down.length === 0 ? 'all sources healthy, nothing to report' : down.join('\n')
```

Note the difference in how the two sources fail: a failed `web_fetch` **rejects**, while a failed `curl` (unreachable host, timeout, HTTP error — hence `-f`) still **resolves** with a non-zero `exit_code`, so the script branches on it instead.

The model receives the final `return` value — one compact line — instead of every intermediate result. Direct tool calls still exist alongside codemode; nothing is hidden or replaced.

## When it pays off

- **Email triage** — list and read many mails in one script, return only a compact digest.
- **Research** — run several searches, dedupe URLs, fetch pages, extract only the relevant passages.
- **Monitoring cronjobs** — check several sources per run and return "nothing to report" on quiet runs, so silent runs cost almost nothing.
- **Bulk operations** — N similar calls in one step instead of N round trips.

## When not to use it

- **A single tool call.** When codemode is active, the agent's system prompt tells it to call single tools directly instead of wrapping them in a script.
- **Weak models.** Writing correct JavaScript is the model's job. Weaker models produce broken scripts more often, which is why the switches default to off and each cronjob can be excluded individually (below).

## Turn it on

There are two switches, both **off by default**, each in a **Codemode** section of its settings page:

- **Codemode for the main agent** ([Settings → Agent](../settings/agent#codemode-experimental)) — the interactive chat agent (web UI and Telegram) gets a `codemode` tool for batching, chaining and filtering. Applies from the next turn; no restart needed.
- **Codemode for background tasks** ([Settings → Tasks](../settings/tasks#codemode-experimental)) — task agents (user tasks, agent-created tasks, cronjob runs, heartbeat runs) get the tool. Applies to tasks **started after** the change; already-running tasks are unaffected. **Memory consolidation never gets codemode.**

```json
{ "codemode": { "mainAgent": true, "tasks": true } }
```

## Per-cronjob override

Each `Task`-type cronjob has its own **Scripted tool calls (codemode)** control in the [Create / Edit dialog](../web-ui/cronjobs#codemode):

| Value | Behavior |
|---|---|
| `Inherit` (default) | Follow the global background-task switch. |
| `On` | This cronjob's task agents get codemode **even when** the global switch is off. |
| `Off` | This cronjob's task agents never get it, **even when** the global switch is on. |

Use it to roll the feature out selectively: enable a monitoring cronjob on a capable model without changing your chat, or exclude one job that misbehaves with scripts. `codemode` is deliberately absent from the per-cronjob [tool toggle list](../web-ui/cronjobs#tool-overrides) — the three-way control is the single place to manage it.

## What scripts can do

- `await tools.<name>({ ...args })` — calls a tool and resolves to its result. A failed call **rejects** with the tool's error text.
- Exactly the tools the owning agent has, minus `codemode` itself (no recursion). A tool you disabled for a cronjob stays uncallable from its scripts — tool restrictions cannot be bypassed through codemode.
- Parallel calls via `Promise.all` / `Promise.allSettled`; one result feeding the next; filter and aggregate before anything reaches the model.
- Output reaches the model through `text(value)`, `console.log(...)` lines, and a top-level `return value`. With several text items, each starts with a `==> text N/M <==` line.

The script is raw JavaScript (not JSON, no code fence) run as an async function body: top-level `await` and `return` work. The sandbox (QuickJS compiled to WebAssembly) has **no Node, no file system, no network, no timers** — the only way to touch the outside world is your own tools. `shell` calls from inside a script resolve to a structured result: `{ output, exit_code }`, where a non-zero exit code does **not** reject — branch on `exit_code` instead.

### Options line

Optionally, the first line of a script sets its limits:

```js
// @options: {"max_output_tokens": 2000, "timeout_ms": 120000}
```

- `max_output_tokens` — output budget (default 10,000).
- `timeout_ms` — deadline (default 5 minutes, capped at 30 minutes).

### Error behavior

- A failed nested call rejects with the tool's error text — handle it with `try/catch` or `Promise.allSettled`.
- A script that throws keeps its **partial output** (everything `text()` / `console.log` produced before the failure), the error message, and a list of the nested calls that already ran — so the agent knows which side effects happened and does not repeat them blindly.
- Stopping a chat turn or a task cancels the running script and its pending tool calls.

## Limits

| Limit | Value |
|---|---|
| Deadline | 5 minutes per script; `timeout_ms` in the options line raises it, capped at 30 minutes. |
| Memory | 256 MB per script (sandbox cap). |
| Output | `max_output_tokens`, default 10,000 (≈ 4 characters per token). |
| Environment | No Node, no file system, no network, no timers. |

Each script starts a fresh sandbox; the overhead is tens of milliseconds, so short scripts are cheap.

### The spill folder

When a script's output exceeds the budget, the result keeps its **head and tail** and the full text is written to a file in a `codemode/` folder in the workspace — `/workspace/codemode/spill-<timestamp>-<id>.txt` in Docker. The result points at the file, and the agent can `read_file` the rest when it needs it. Spill files are pruned after **7 days**.

## How codemode calls appear

- **Chat** — a codemode call renders as a card with the script, the nested tool calls (name, summary line, status, duration — updated live while the script runs) and the output. Collapsed, the card shows how many nested calls ran and which tools were used. After a page reload the same card renders — the full nested-call list is persisted with the tool row.
- **Task event viewer** — the same card appears in the [task event timeline](../web-ui/tasks#event-timeline) for background runs.
- **Activity logs** — every nested call gets its own row in [Activity Logs](../web-ui/activity-logs), marked **via codemode** and linked to its parent codemode call, so logs stay complete and filterable. Loop detection sees nested calls the same way it sees direct ones.
- **Attachments** — files a script sends with `send_file_to_user` arrive as attachments, exactly like direct calls. Images generated with `generate_image` only land in the workspace; the script (or the agent after it) must still send them with `send_file_to_user` for you to receive them.

## See also

- [Built-in Tools](./tools) — the tool registry codemode scripts call.
- [Settings → Agent](../settings/agent#codemode-experimental) — the main-agent codemode switch.
- [Settings → Tasks](../settings/tasks#codemode-experimental) — the background-task codemode switch.
- [Web UI → Cronjobs](../web-ui/cronjobs) — the per-cronjob three-way control.
- [Tasks & Cronjobs](./tasks-and-cronjobs) — background tasks and the scheduler.
- [Activity Logs](../web-ui/activity-logs) — where nested calls are recorded.
- [`settings.json` Reference](../reference/settings#codemode) — the raw schema of the switches.
- [File Paths](../reference/file-paths) — where the workspace (and the spill folder) lives.
