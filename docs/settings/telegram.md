# Telegram

Connect Axiom to a Telegram bot so you can talk to the same agent — with the same memory, tools, and tasks — from your phone. For setup narrative and webhook vs polling, see the [Telegram Bot](../guide/telegram) guide.

**URL:** `/settings?tab=telegram`

## Enabled

Master toggle for the Telegram integration. When off, the bot is not started on container boot and no incoming messages are processed.

## Bot token

The secret token from [@BotFather](https://t.me/BotFather). Stored as a password field; the actual value is written into [Secrets](./secrets) as `TELEGRAM_BOT_TOKEN` and never returned in plain text afterwards.

To rotate: paste a new token here and save. The old bot will stop working on the next request, the new one will be active immediately.

## Batching delay

When a human types a multi-line message on Telegram, each line often arrives as a separate update. Axiom waits `batchingDelayMs` after each arriving message before flushing them all to the agent — this way "Hi / how are you / btw" becomes one prompt instead of three.

Default: `2500` (2.5s). Range: 0 – 10 000. Set to `0` for no batching (each message triggers an agent turn immediately).

```json
{ "batchingDelayMs": 2500 }
```

## Telegram users

The user directory. Every Telegram account that has ever `/start`ed the bot shows up here with one of three statuses:

| Badge | Meaning |
|---|---|
| `pending` | First contact — the bot replied "waiting for approval" and is ignoring this user until you approve. |
| `approved` | Messages are processed as normal. |
| `rejected` | Explicitly blocked. The bot silently drops all incoming messages from this account. |

Each row shows avatar, display name, `@username`, numeric Telegram ID, and the linked Axiom user (if any).

### Approve

Primary action on a `pending` row. Clicking it flips status to `approved` and lets the user talk to the agent.

### Row menu

Additional actions under the `⋮` menu:

- **Approve** / **Reject** — toggle status.
- **Assign user** — link this Telegram account to an Axiom user (or leave unassigned). The assignment determines which `memory/users/<username>.md` profile the agent loads for this conversation, and which user "owns" any tasks created from Telegram.
- **Delete** — remove the Telegram user entry entirely. They re-appear as `pending` if they message the bot again.

### Refresh

Reloads the list from the backend — useful after someone joins while you're looking at the page.

## Full `settings.json` block

```json
{
  "telegramEnabled": true,
  "telegramBotToken": "(masked — stored in secrets.json)",
  "batchingDelayMs": 2500
}
```

The approved/rejected user list itself is not stored in `settings.json` — it lives in the Axiom database (`telegram_users` table), managed via this panel or the `/api/telegram-users` endpoints.
