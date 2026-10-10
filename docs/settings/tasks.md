# Tasks

Defaults and safety rails for **background tasks and cronjobs** — the long-running jobs Axiom kicks off without a user sitting in front of a chat window. For what tasks _are_ and how to create them, see [Tasks & Cronjobs](../concepts/tasks-and-cronjobs).

**URL:** `/settings?tab=tasks`

## General Task Settings

### Default provider

Provider + model used for task execution when the task itself doesn't specify one. Defaults to the currently active chat provider; override if you want background jobs to use a different model than your interactive chat.

Tasks are built for **hard work** — long-running, tool-heavy jobs without a human waiting on the other end. Feel free to pick a stronger, slower model here than you'd tolerate in chat (e.g. a top-tier reasoning model). Latency barely matters; quality of the end result does.

```json
{ "tasks": { "defaultProvider": "openai:gpt-5.4" } }
```

### Max duration

Hard upper bound on a single task run, in minutes. Any task hitting this limit is killed. Default: `30`. Range: 1 – 1440.

Use this to protect your wallet against runaway agents in an infinite tool loop.

Axiom has no built-in hard spend cap. Max duration and loop detection bound how long a task runs and catch runaway loops, but they do not limit absolute cost. The hard cost ceiling is set at the provider: for subscription/OAuth providers it is your plan allowance (shown as the [subscriber usage quota](../web-ui/providers#subscriber-usage-quota-oauth-plans) on the Providers page), and for pay-per-token API keys it is a spend limit you configure with the provider.

```json
{ "tasks": { "maxDurationMinutes": 30 } }
```

### Telegram delivery

How task results are pushed to the user who owns them (if Telegram is configured).

| Value | Behavior |
|---|---|
| `auto` | Deliver via Telegram only when the user isn't actively using the web UI. |
| `always` | Deliver via Telegram every time, even if they're online in the web UI. |

```json
{ "tasks": { "telegramDelivery": "auto" } }
```

### Background thinking level

Reasoning level for tasks and other internal background jobs (heartbeat, consolidation-side work). Separate from the main [chat thinking level](./agent#thinking-level) so you can keep chat snappy and background jobs thoughtful (or vice versa).

Values: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Like the chat setting, the dropdown only offers the levels supported by the selected **Default provider** model (or the active model when tasks use the active provider); unsupported levels are rounded to the nearest supported one.

```json
{ "tasks": { "backgroundThinkingLevel": "minimal" } }
```

## Codemode (experimental)

Switches for the [codemode](../concepts/codemode) tool — a JavaScript script that batches, chains and filters tool calls, so only the script's output reaches the model. Both switches are **off by default**, and the section is marked *Experimental* in the UI: the feature may change between releases, and script quality depends on the model.

### Codemode for the main agent

Adds the `codemode` tool to the interactive chat agent on every channel (web UI and Telegram). Applies from the next turn — no restart needed.

```json
{ "codemode": { "mainAgent": true } }
```

### Codemode for background tasks

Adds the `codemode` tool to task agents — user tasks, agent-created tasks, cronjob runs and heartbeat runs. Applies to tasks **started after** the change; already-running tasks are unaffected. Memory consolidation never uses codemode. Individual cronjobs can override this switch with the three-way control in the [cronjob form](../web-ui/cronjobs#codemode) (inherit / on / off).

```json
{ "codemode": { "tasks": true } }
```

When to use it, what scripts can do, the limits and where the switches' effects show up: [Codemode](../concepts/codemode).

## Loop detection

Tasks can get stuck — repeating the same failing tool call over and over, or going in circles without making progress. Loop detection catches this and terminates the task. Which of the two it catches depends on the detection method below.

### Enable loop detection

Master toggle. Default: `true`. Leave it on unless you're debugging an agent that actively needs to retry the same tool hundreds of times.

```json
{ "tasks": { "loopDetection": { "enabled": true } } }
```

### Detection method

| Value | How it works |
|---|---|
| `systematic` | Pure rule-based. Fires when the same tool is called with the same arguments and returns the same error `maxConsecutiveFailures` times in a row. A call counts as failed when the tool reports an error, for example `edit_file` not finding the text it should replace. Fast, zero extra tokens. |
| `smart` | Periodically asks a small LLM "is this agent making progress?". Slower, costs tokens, catches subtle loops. |
| `auto` | Start with `systematic`; escalate to `smart` if the rule-based signal is ambiguous. A good all-round choice, though the built-in default is `systematic`. |

```json
{ "tasks": { "loopDetection": { "method": "auto" } } }
```

### Max consecutive failures

How many identical failing tool calls in a row count as a loop. Default: `3`. Range: 1 – 20.

```json
{ "tasks": { "loopDetection": { "maxConsecutiveFailures": 5 } } }
```

### Smart provider

Only shown for `smart` / `auto`. Which LLM judges "is the agent making progress?". Pick something small (`gpt-5.4-mini`, `claude-haiku`, etc.).

```json
{ "tasks": { "loopDetection": { "smartProvider": "openai:gpt-5.4-mini" } } }
```

### Smart check interval

Only shown for `smart` / `auto`. How often (every _N_ tool calls) the smart check runs. Default: `5`. Range: 1 – 50. Lower = more sensitive, more tokens; higher = cheaper, slower to react.

```json
{ "tasks": { "loopDetection": { "smartCheckInterval": 10 } } }
```

## Status updates

While a task runs, Axiom can push periodic progress signals into the parent chat (the session that triggered the task) and, when Telegram delivery is configured, into that user's Telegram DM. Each signal is a short `<task_status type="periodic_update">` line with the task's runtime, tool-call count and token estimate plus the `/kill_task <id>` hint.

### Enable periodic status updates

Master toggle. Default: `false` — opt-in to avoid noisy chats out of the box. Turn it on if you want a visible heartbeat for long-running background tasks.

```json
{ "tasks": { "statusUpdates": { "enabled": true } } }
```

### Status update interval

How often to emit a status update, in minutes. Default: `10`. Range: 1 – 120. Set higher for long, quiet tasks; lower if you want a more responsive heartbeat.

```json
{ "tasks": { "statusUpdates": { "intervalMinutes": 10 } } }
```
