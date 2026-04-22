# Tasks

Defaults and safety rails for **background tasks and cronjobs** — the long-running jobs Axiom kicks off without a user sitting in front of a chat window. For what tasks _are_ and how to create them, see [Tasks & Cronjobs](../guide/tasks-and-cronjobs).

**URL:** `/settings?tab=tasks`

## General Task Settings

### Default provider

Provider + model used for task execution when the task itself doesn't specify one. Defaults to the currently active chat provider; override if you want background jobs to use a different (usually cheaper) model than your interactive chat.

```json
{ "tasks": { "defaultProvider": "openai:gpt-4o-mini" } }
```

### Max duration

Hard upper bound on a single task run, in minutes. Any task hitting this limit is killed. Default: `30`. Range: 1 – 1440.

Use this to protect your wallet against runaway agents in an infinite tool loop.

### Telegram delivery

How task results are pushed to the user who owns them (if Telegram is configured).

| Value | Behavior |
|---|---|
| `auto` | Deliver via Telegram only when the user isn't actively using the web UI. |
| `always` | Deliver via Telegram every time, even if they're online in the web UI. |

### Background thinking level

Reasoning level for tasks and other internal background jobs (heartbeat, consolidation-side work). Separate from the main [chat thinking level](./agent#thinking-level) so you can keep chat snappy and background jobs thoughtful (or vice versa).

Values: `off`, `minimal`, `low`, `medium`, `high`.

## Loop detection

Tasks can get stuck — calling the same tool with the same args in a loop, or looping over a tool that keeps failing. Loop detection catches this and terminates the task.

### Enable loop detection

Master toggle. Default: `true`. Leave it on unless you're debugging an agent that actively needs to retry the same tool hundreds of times.

### Detection method

| Value | How it works |
|---|---|
| `systematic` | Pure rule-based. Counts consecutive failing tool calls against `maxConsecutiveFailures`. Fast, zero extra tokens. |
| `smart` | Periodically asks a small LLM "is this agent making progress?". Slower, costs tokens, catches subtle loops. |
| `auto` | Start with `systematic`; escalate to `smart` if the rule-based signal is ambiguous. Recommended default. |

### Max consecutive failures

How many back-to-back failing tool calls count as a loop. Default: `5`. Range: 1 – 20.

### Smart provider

Only shown for `smart` / `auto`. Which LLM judges "is the agent making progress?". Pick something small (`gpt-4o-mini`, `claude-haiku`, etc.).

### Smart check interval

Only shown for `smart` / `auto`. How often (every _N_ tool calls) the smart check runs. Default: `10`. Range: 1 – 50. Lower = more sensitive, more tokens; higher = cheaper, slower to react.

## Status updates

While a task runs, the agent can push periodic progress updates into the task log (and, if `telegramDelivery` is set, into the Telegram chat).

### Status update interval

How often to emit a status update, in minutes. Default: `5`. Range: 1 – 120. Set higher for long, quiet tasks; lower if you want a visible heartbeat in chat.

## Full `settings.json` block

```json
{
  "tasks": {
    "defaultProvider": "",
    "maxDurationMinutes": 30,
    "telegramDelivery": "auto",
    "backgroundThinkingLevel": "minimal",
    "loopDetection": {
      "enabled": true,
      "method": "auto",
      "maxConsecutiveFailures": 5,
      "smartProvider": "",
      "smartCheckInterval": 10
    },
    "statusUpdateIntervalMinutes": 5
  }
}
```
