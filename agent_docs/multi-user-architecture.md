# Multi-user architecture

Axiom is multi-user with **cooperative isolation**: separation at context, tool and API level, not at OS level. Shell, sudo and file tools stay available to everyone. User-facing description: `docs/concepts/multi-user.md`.

## UserScope (`packages/core/src/user-scope.ts`)

`UserScope` is the single identity object passed through core: `id`, `username`, `role`, `isBootstrapAdmin`, `paths` and effective `settings`.

- `resolveUserScope(db, userId)` accepts number or string, returns `null` for non-numeric ids (e.g. `telegram-<id>` pseudo users), unknown ids and soft-deleted users.
- The bootstrap admin is the admin with the lowest id (`getBootstrapAdminId`). Admins only: legacy instances may have demoted their first account, and the bootstrap admin manages the global secrets and owns the legacy folders. `PUT /api/users/:id` refuses to demote it or to promote an older account past it, so it never changes. Its `paths` are the legacy locations (`/data/memory/users/<name>.md`, `/data/memory/daily`, `/data/config/HEARTBEAT.md`, `/workspace`). Everyone else gets `/data/users/<name>/{PROFILE.md,HEARTBEAT.md,daily/}` and `/workspace/<name>`.
- `resolveUserPaths`, `checkUsernameAvailable` and `createUserFolders` are the only places that know the layout. Don't build user paths by hand.
- `settings` comes from `resolveEffectiveSettings` (`user-settings.ts`): per-user model, thinking level, language and timezone, falling back to the admin's values.
- Authorization always uses `role`, never `isBootstrapAdmin`; the latter only selects legacy paths and ownership.
- `isMultiUser(db)` gates behavior that must stay unchanged on single-user instances.

Rule: new per-user features take a `UserScope` (or an owner id) explicitly. Never read "the current user" from module state.

## Per-user runtime pool

`AgentCore` (`agent.ts`) keeps `runtimes: Map<userId, UserRuntime>`. Each entry owns its own `AgentRuntimeBoundary` (transcript, tools, system prompt), its own `MessageQueue`, `interactiveSessionId` and `activeTurns`. Consequences:

- Turns of different users run in parallel; only one user's turns are serialized.
- `/stop`, `/new`, session timeout and session summaries act on one entry.
- `hasModelOverride` marks runtimes running on the user's own model; changing the global or personal model/thinking level rebuilds the affected entries only.
- Session end writes the summary and extracts facts for the session's owner, into that user's `paths.dailyDir`.
- Soft-deleting a user ends their runtime without summary or fact extraction.

## Scoped tools (`scoped-tools.ts`)

`createScopedTools(scope, deps)` builds the tool set for one user and binds every tool to the scope at creation: task tools (`create_task`, `list_tasks`, `resume_task`, `stop_task`), cronjob/reminder tools (chat only), `send_file`, plus the base tools unless `excludeBaseTools` is set. The actor's role is read from the database on every access check, because a runtime outlives role changes. Both the chat runtime and background task agents use it, so tasks inherit the owner's workspace, email accounts, secrets, facts and chat history. Don't add tools to a runtime outside this factory when they touch user data.

Data tools filter by the scope's user id: `read_chat_history`, `search_memories` (also in background tasks), email accounts, secrets (user secrets override global ones for that user only).

## AccessPolicy (`access-policy.ts`)

Pure functions deciding who may do what with tasks and cronjobs:

- `getViewLevel(actor, resource, channel)` → `full | metadata | none`. Owners see everything. A non-owner non-admin sees nothing. An admin sees foreign resources fully on channel `ui`, but only title, owner and status on channel `agent`.
- `can(actor, resource, action, channel)`. Owners may do every action valid for the resource kind. Admins may only `view` (per view level), `stop`, `delete` and `toggle` foreign resources — never `edit`, `restart`, `trigger` or `resume`.
- `canCreateFor(actor, ownerId)`: nobody creates on behalf of someone else.

`channel: 'ui'` is the REST API / WebSocket; `'agent'` is any LLM tool or slash command. Every REST endpoint and tool that touches tasks or cronjobs must go through `can` / `getViewLevel`. Hiding things only in the frontend is not enough.

## Other invariants

- **Auth:** roles are read from the database, never trusted from the token. Password reset or role change invalidates all tokens and closes sockets.
- **Soft delete:** the user row stays (username reserved, usage attributed as "<name> (deleted)"); owned data is removed.
- **Consolidation:** runs once per user, sequentially, bootstrap admin last; global steps are `<admin_only>` sections of `CONSOLIDATION.md`.
- **Heartbeat:** per-user switch and `HEARTBEAT.md`; interval, night hours and master switch are global; night mode uses the user's timezone.
- **Telegram:** with several users, approved accounts without a linked user are refused; groups answer only admin-linked accounts.

## Verification

Run `npm test` in `packages/core`, `packages/web-backend` and `packages/telegram`, plus `npm run baseline:parity`.
