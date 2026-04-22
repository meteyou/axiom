# Agent

Language preferences, active provider + model, reasoning level, and the user-editable rules the agent follows on every turn.

**URL:** `/settings?tab=agent`

## Agent Rules

A card at the top of the panel links to `/data/config/AGENTS.md` — the file the agent reads on every conversation as its "user-editable behavior rules" block.

Click **Open editor** to jump to the [Agent Instructions](../guide/instructions#agents-md-the-agent-contract) page, where the file opens in a full-screen Markdown editor with a **Restore default** button.

See [Agent Instructions](../guide/instructions) for what belongs in this file, the default template, and editing tips.

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

The current date and time in this timezone are injected into the system prompt so the agent always knows "now". Also used for cron evaluation (Tasks & Heartbeat) and the naming of `memory/daily/<date>.md` files.

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

Configure providers themselves (add new ones, enable/disable models, set API keys) on the [LLM Providers](../guide/providers) page, not here.

## Thinking level

How hard the main chat agent reasons before replying. Higher levels are slower and more expensive; they are silently ignored by models that don't support reasoning (e.g. plain GPT‑4o).

| Value     | Use for                                             |
|-----------|-----------------------------------------------------|
| `off`     | Plain chat, no reasoning tokens.                    |
| `minimal` | Tiny amount of reasoning — default for most people. |
| `low`     | Quick internal planning.                            |
| `medium`  | Multi-step problems.                                |
| `high`    | Hard reasoning, tool-heavy flows.                   |

This only applies to the **interactive chat agent**. Background jobs (tasks, heartbeat) have their own setting in [Tasks → Background thinking level](./tasks#background-thinking-level).

```json
{ "thinkingLevel": "minimal" }
```
