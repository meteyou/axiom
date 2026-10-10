# Agent

Language preferences, active provider + model, reasoning level, the experimental codemode switch, and the user-editable rules the agent follows on every turn.

**URL:** `/settings?tab=agent`

## Agent Rules

A card at the top of the panel links to `/data/config/AGENTS.md` — the file the agent reads on every conversation as its "user-editable behavior rules" block.

Click **Open editor** to jump to the [Agent Instructions](../concepts/instructions#agents-md) page, where the file opens in a full-screen Markdown editor with a **Restore default** button.

See [Agent Instructions](../concepts/instructions) for what belongs in this file, the default template, and editing tips.

## Agent language

Forces the agent's reply language. Mapped to the `<language>` block in the system prompt.

| Value                                                                                                                  | Behavior                                               |
|------------------------------------------------------------------------------------------------------------------------|--------------------------------------------------------|
| `match`                                                                                                                | Mirror the user's language on each turn.               |
| `English`, `German`, `French`, `Spanish`, `Italian`, `Portuguese`, `Dutch`, `Russian`, `Chinese`, `Japanese`, `Korean` | Reply in this language regardless of the user's input. |

Applies immediately on the next turn.

```json
{ "language": "German" }
```

## Timezone

The current date in this timezone is injected into the system prompt, and the minute-level time is appended to each user message, so the agent always knows "now" (the time is kept out of the system prompt to avoid invalidating provider prompt caches every minute — see [System Prompt → layer 16](../concepts/system-prompt#_16-current-date-current-date)). Also used for cron evaluation (Tasks & Heartbeat) and the naming of `memory/daily/<date>.md` files.

Default: `UTC`. Mirrors the container's `TZ` env var if set.

```json
{ "timezone": "Europe/Vienna" }
```

## Provider

The active provider + model used for all normal chat conversations. The dropdown shows every enabled model across every configured provider (e.g. `ChatGPT Plus (gpt-5.4-mini)`, `Anthropic (claude-sonnet-4)`, `Ollama (qwen2.5-coder)`).

Changing this value activates the chosen combination immediately — in-flight sessions will use the new provider on their next turn.

Internally stored as two keys:

```json
{
  "activeProviderId": "openai-chatgpt-plus",
  "activeModelId": "gpt-5.4-mini"
}
```

Configure providers themselves (add new ones, enable/disable models, set API keys) on the [Providers](../web-ui/providers) page, not here.

## Thinking level

How hard the main chat agent reasons before replying. Higher levels are slower and more expensive.

The dropdown only offers the levels the **active model** supports (from the model catalog or the model's [Edit Model](../web-ui/providers#edit-model-dialog) settings). A model without reasoning only offers `off`. If the stored level isn't supported by the current model — e.g. after switching models — it is marked *not supported* and the model runs with the nearest supported level instead (the next higher one first, otherwise the next lower one).

| Value     | Use for                                             |
|-----------|-----------------------------------------------------|
| `off`     | Plain chat, no reasoning tokens.                    |
| `minimal` | Tiny amount of reasoning — default for most people. |
| `low`     | Quick internal planning.                            |
| `medium`  | Multi-step problems.                                |
| `high`    | Hard reasoning, tool-heavy flows.                   |
| `xhigh`   | Extra effort — only models that explicitly support it. |
| `max`     | Maximum effort — only models that explicitly support it. |

This only applies to the **interactive chat agent**. Background jobs (tasks, heartbeat) have their own setting in [Tasks → Background thinking level](./tasks#background-thinking-level).

```json
{ "thinkingLevel": "minimal" }
```

## Codemode (experimental)

Adds the [codemode](../concepts/codemode) tool to the interactive chat agent on every channel (web UI and Telegram) — a JavaScript script that batches, chains and filters tool calls, so only the script's output reaches the model. **Off by default**, and the section is marked *Experimental* in the UI: the feature may change between releases, and script quality depends on the model. Applies from the next turn — no restart needed.

Background task agents have their own switch in [Tasks → Codemode](./tasks#codemode-experimental).

```json
{ "codemode": { "mainAgent": true } }
```

## Upload retention

How many days uploaded files in `/data/uploads/` are kept before the cleanup job removes them. Applies to images, audio, and any other files users attach from the web UI or Telegram. Default: `30`. Set to `0` to have the next cleanup run delete all uploads.

```json
{
  "uploads": {
    "retentionDays": 30
  }
}
```

> The cleanup job also prunes the referencing rows in the database so stale upload metadata doesn't linger after the files are gone.

## Resilience

How the agent reacts when a provider misbehaves mid-turn. All five fields are read at the **start of every turn**, so a save applies to the next message — no restart needed.

### Automatic retry

When a turn fails with a transient provider error (429, 5xx, timeout, dropped stream, or a watchdog stall abort), Axiom discards the failed attempt and re-runs the turn from the existing transcript — the user message is never sent twice. Errors the provider won't recover from on its own (invalid API key, quota, billing) fail immediately, and a turn you stop yourself is never retried.

| Field                 | Default | Range              | Effect                                                                       |
|-----------------------|---------|--------------------|------------------------------------------------------------------------------|
| **Automatic retry**   | on      | —                  | Master switch. Off means every provider error ends the turn immediately.     |
| **Maximum retries**   | `3`     | `0` – `10`         | Retry budget per turn. `0` behaves like the switch being off.                |
| **Base delay**        | `2000` ms | `100` – `60000` ms | Backoff base; attempt *n* waits `base × 2^(n-1)` — with the defaults 2s / 4s / 8s. |

While a retry is pending the chat shows a `Retrying (n/max)…` status. Once the budget is exhausted, the turn ends with a persisted error message containing the provider's error text.

```json
{
  "retry": { "enabled": true, "maxRetries": 3, "baseDelayMs": 2000 }
}
```

### Stall thresholds

The watchdog measures how long a turn goes without a single chunk from the provider. At the warn threshold a `provider_stall` message is written to the chat (it survives a reload and is updated in place when the provider recovers); at the abort threshold the stream is hard-aborted, which counts as a retryable error. Time spent executing tool calls (shell commands, image generation, …) does not count — the clock only runs while Axiom is waiting for the provider.

| Field                       | Default   | Range                                        |
|-----------------------------|-----------|-----------------------------------------------|
| **Stall warning threshold** | `30000` ms | `1000` – `600000` ms                          |
| **Stall abort threshold**   | `90000` ms | `1000` – `3600000` ms, must be ≥ the warning threshold |

```json
{
  "watchdog": { "stallWarnMs": 30000, "stallAbortMs": 90000 }
}
```

Stall frequency and average duration (split by recovered vs. aborted) are aggregated on the [Token Usage](../web-ui/token-usage) page. Telegram delivery of the warning is opt-in — see [Telegram → Send stall warnings](./telegram#send-stall-warnings).

## Context compaction

When a chat or background task approaches the model's context limit, older messages are replaced by a summary and the most recent messages are kept verbatim. How this works — triggers, the summary format, the per-window caps — is explained in [Context Compaction](../concepts/compaction). Values are read fresh before every check, so a save applies without a restart.

| Field                                   | Default    | Range                     | Effect                                                                                                   |
|-----------------------------------------|------------|---------------------------|----------------------------------------------------------------------------------------------------------|
| **Automatic compaction**                | on         | —                         | Master switch for automatic compaction (main chat and tasks). `/compact` works even when off.            |
| **Soft context budget**                 | `200000`   | `8192` – `10000000`, empty | Compact above this many tokens even if the window is larger. Empty = compact only near the window limit. |
| **Reserve tokens**                      | `16384`    | `1024` – `1000000`        | Room left for the answer; compaction triggers at window minus reserve. Capped at 25% of the window.     |
| **Keep recent tokens**                  | `20000`    | `1000` – `1000000`        | Most recent part of the conversation kept verbatim. Capped at 30% of the trigger.                        |
| **Summary limit**                       | `8192`     | `256` – `200000`          | Maximum output tokens of the summary. Capped at 15% of the trigger.                                      |
| **Tool result length in summary input** | `2000`     | `200` – `100000` chars    | Tool results are cut to this length when the summarizer reads them.                                      |
| **Compact background tasks**            | on         | —                         | Apply automatic compaction to background tasks too (requires the master switch).                         |
| **Soft context budget for tasks**       | `150000`   | `8192` – `10000000`, empty | Replaces the soft budget for background tasks. Empty = compact only near the window limit.              |

`reserveTokens` and `keepRecentTokens` can be overridden per model in the [Edit Model dialog](../web-ui/providers#edit-model-dialog). If a save leaves some models with a window too small for system prompt + summary + kept messages, the affected models are listed above the fields.

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000,
    "summaryMaxTokens": 8192,
    "maxContextTokens": 200000,
    "toolResultMaxChars": 2000,
    "tasks": { "enabled": true, "maxContextTokens": 150000 }
  }
}
```
