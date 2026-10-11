# Multi-User

Axiom can be shared by several people on one instance — family, a small team. Each account gets its own agent runtime, its own conversation and its own private data. The wiki stays shared.

## Isolation level: cooperative

Separation happens at **context, tool and API level**:

- A user's conversation, facts, profile, tasks, cronjobs and email never end up in another user's agent context, API responses or notifications.
- Every user's agent runs independently and in parallel. One user's `/stop`, `/new` or session timeout never touches another user's turn.

It is **not hard isolation**. Shell, sudo and the file tools stay available to everyone, so a determined user can read other users' files through the shell. Treat accounts as cooperative: people you trust not to snoop. If you need hard separation, run a separate Axiom instance.

## Private vs. shared

| Private per user | Shared |
|---|---|
| Chats, session summaries, daily notes | Wiki and sources |
| Facts and profile | `MEMORY.md` (general lessons only — no personal data) |
| Tasks, cronjobs, reminders, heartbeat | `SOUL.md`, `AGENTS.md`, `TASKS.md`, `CONSOLIDATION.md` |
| Uploads and workspace files | Installed and agent-created skills |
| Email accounts and sent log | Providers and global settings |
| Secrets (override global ones of the same name) | Global secrets |
| Chat model, thinking level, language, timezone | |

The agent is instructed to keep personal information out of the wiki, `MEMORY.md` and shared skills, and to refuse changes to global configuration files on behalf of regular users.

## Where files live

The **bootstrap admin** (see [below](#bootstrap-admin)) keeps every location a single-user instance has always used. Each additional user gets:

- `/data/users/<username>/` — `PROFILE.md`, `HEARTBEAT.md`, `daily/`
- `/workspace/<username>/` — the default working directory for that user's shell and file tools

Usernames are alphanumeric only and are rejected if a matching folder already exists under `/workspace` or `/data/users`. Deleted usernames stay reserved. Accounts created before multi-user support skipped that check, so deleting such an account keeps its `/workspace/<username>/` folder — it may belong to someone else. See [File Paths](../reference/file-paths).

## Roles

- **User** — chat, own tasks, own cronjobs, email, [Memory](../web-ui/memory) (own profile, notes, facts plus the shared wiki), and the Settings tabs for personal settings (Agent, Heartbeat, Email, Secrets). The [Users](../web-ui/users) page shows only their own account.
- **Admin** — the operator account. Sees everything in the web UI: all tasks and cronjobs with an owner filter, all email accounts (without passwords), the full sent log, [usage](../web-ui/token-usage) per user. Can stop tasks and disable or delete cronjobs of any user, from the UI or through the agent.

The admin never acts *on behalf of* others: restarting, triggering, editing or creating tasks and cronjobs for another user is refused. Through the agent, the admin sees only title, owner and status of foreign tasks — never prompts or results. The admin's own agent context contains only the admin's own data.

The admin's settings (model, thinking level, language, timezone) are the **global defaults**. Users see "Use default (admin: …)" and inherit unless they pick their own. Heartbeat interval, night-mode hours and the heartbeat master switch stay global.

## Bootstrap admin

The bootstrap admin is the oldest admin account — normally the first account, created from `ADMIN_PASSWORD` on first start (see [Configuration](../guide/configuration)). If that account was demoted before multi-user support existed, the next-oldest admin takes its place. The bootstrap admin can be neither deleted nor demoted, and an older account cannot be promoted past it, so the instance always keeps the same legacy owner. Nightly [memory consolidation](./memory#memory-consolidation) runs once per user, with the bootstrap admin last.

## Recommended setup

On an instance with more than one user, don't use the admin account for daily chatting:

1. Log in as the bootstrap admin and configure providers, default model and global settings.
2. Create your own regular account for everyday use, plus one for each other person. Set their language and timezone in the dialog.
3. Keep the admin account for monitoring, usage and cleanup.

Link each person's Telegram identity to their own account in [Settings → Telegram](../settings/telegram). An approved Telegram account without a linked user is refused once several users exist; on a single-user instance it acts as the admin account.

A single-user instance behaves exactly as before.

## See also

- [Users](../web-ui/users) — creating, resetting and deleting accounts
- [Tasks & Cronjobs](./tasks-and-cronjobs)
- [Memory System](./memory)
