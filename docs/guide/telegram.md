# Telegram Bot

> **This page is a stub.** Full content will be written together with the agent.

Axiom ships with a Telegram integration that lets you talk to the same agent (with the same memory and tools) from your phone. Configure under **Settings → Telegram** or in `/data/config/telegram.json`:

```json
{
  "enabled": true,
  "botToken": "123456:ABC...",
  "adminUserIds": [12345678],
  "pollingMode": true,
  "webhookUrl": "",
  "batchingDelayMs": 2500
}
```

- Create a bot via [@BotFather](https://t.me/BotFather), grab the token.
- Find your numeric Telegram user ID (e.g. via [@userinfobot](https://t.me/userinfobot)) and add it to `adminUserIds` — only listed users can message the bot.
- Use **polling mode** for simple setups, **webhook mode** if your container is publicly reachable on HTTPS.

Tasks and cronjobs can deliver their results via Telegram (`tasks.telegramDelivery` setting).

---

*To be expanded: webhook setup behind a reverse proxy, group-chat behavior, message-batching semantics, attaching files, multi-user mapping to user profiles, slash commands.*
