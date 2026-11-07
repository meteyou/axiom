# Architecture Conventions

Structure rules, boundary constraints and verification checks for the Axiom monorepo.

## 1) Package Boundaries

- `packages/core` is the platform-independent boundary and imports no platform package.
- `web-backend`, `web-frontend` and `telegram` consume Core only via `@axiom/core` (no `@axiom/core/src/*` deep imports).
- `web-frontend` does not import `web-backend` or `telegram`.
- `telegram` does not import `web-backend` or `web-frontend`.

## 2) Backend Layering

Modular API domains live under `packages/web-backend/src/api/modules/<domain>/`:

```text
route -> controller -> service -> schema/mapper
```

- **route**: HTTP wiring, middleware, route registration
- **controller**: request/response orchestration, error/status mapping
- **service**: business logic, coordination of Core/Infra
- **schema/mapper**: validation, DTO mapping, transport transformation

## 3) Frontend Layering

- `pages/` orchestrates only.
- Feature logic lives in `features/`.
- HTTP/transport logic lives in `api/`.

## 4) Core Deep Modules

Integrations (heartbeat, consolidation scheduler, task tools, channels) use these boundaries instead of low-level wiring:

- **Agent runtime**: `createAgentRuntime` / `AgentRuntimeBoundary`. Per-user pool: see `multi-user-architecture.md`.
- **Task runtime**: `createTaskRuntime` / `TaskRuntimeBoundary`.
- **Chat turns**: `TurnRunner` (`core/src/turn-runner.ts`).

### TurnRunner invariants

- It owns the turn lifecycle (streaming, chunk persistence, stall watchdog, abort), buffers the active turn in memory and replays it to consumers that attach mid-turn. Channels (`ws-chat`, Telegram) only dispatch into it and forward its events; they must not own stream state.
- There is exactly **one** runner per process, built in `web-backend/src/bootstrap/runtime-composition.ts` and shared by WebSocket chat and Telegram. A turn started in one channel streams into the other, and a manual retry cannot race a channel-local runner.
- Turns are never recovered across a process restart.
- Turns are keyed by `agentUserId` (the identity the agent sees). The numeric `userId` is only used for persistence; a turn without one streams without persisting.

### Stalls, errors and retry

- **Provider stalls** (`core/src/provider-stall.ts`): the watchdog emits `stall_warning` / `stall_resolved` chunks and persists a single `provider_stall` chat row, updated in place on resolution. Channels render that row and do not invent their own stall messaging. Thresholds come from `settings.json → watchdog`, read at turn start.
- The watchdog is **paused while a tool call executes**: tools are bounded by their own timeouts, and a hard abort mid-tool would auto-retry the turn and re-run side effects.
- **Terminal failures** (`core/src/turn-error.ts`): the runner persists a `turn_error` chat row (provider error text, `cause`, `retryable`, `attempts`) and emits an `error` chunk with the row id. A failed turn must never end silently.
- **Manual retry** (`core/src/turn-retry-action.ts`): every error row carries a `retryActionId` registered in the chat-action registry (`web-backend/src/turn-retry-chat.ts`). The handler validates freshness against the database (session still open, no newer user/assistant/tool row, no running turn) and calls `TurnRunner.retryTurn`, which continues the existing transcript instead of re-sending the user message. The registry is in-memory, so buttons minted before a restart answer "no longer available".
- Retry resolutions cross channels through `core/src/turn-retry-notifier.ts` (same pattern as `email-approval-notifier.ts`): whoever answers first wins, every other channel disables its button.
- Telegram's stall / auto-retry notices are opt-in (`telegram.json → sendStallWarnings`). The terminal error and its Retry button are always delivered.

## 5) Session Model

Session kind, origin and lineage are columns on the `sessions` table, **never** encoded into the session ID.

- `sessions.id` is always a UUID. The only generator is `generateSessionId()` in `packages/core/src/session-manager.ts`; no code constructs session IDs inline.
- `sessions.type`: `interactive` (web, telegram, REST), `task` (including cronjob-triggered tasks), `heartbeat`, `consolidation`, `loop_detection`.
- `sessions.source`: `web`, `telegram`, `telegram-group`, `rest`, `task`, `system`.
- `sessions.parent_session_id` links child sessions (task, heartbeat, loop_detection) to the interactive session that triggered them.
- System-originated messages (task-injection responses, task-result notifications) are logged under the **target user's interactive session**. There is no `system` or `notification` session type.
- Consumers filter by `sessions.type` / `sessions.source` via JOIN, **never** via `LIKE 'task-%'` or other ID-prefix inspection.
- Legacy prefix IDs (`session-*`, `web-*`, `task-*`, `agent-heartbeat-*`, …) survive only in the idempotent migration in `packages/core/src/database.ts`, which backfills `type`, remaps them to UUIDs and rewrites all references.

## 6) Enforcement & Verification

`eslint.config.js` enforces package boundaries, backend and frontend layer boundaries, and the ban on legacy backend adapter imports (`routes/settings|providers|memory|tasks`).

Run before merging refactorings or structural changes:

```bash
npm run baseline:parity
```

It runs the same steps as CI (`.github/workflows/ci-guardrails.yml`, on PRs against `main` and pushes to `main`):

- `npm run lint`
- `npm run baseline:unit`: Core, Telegram and frontend unit tests
- `npm run baseline:api`: backend API/transport tests
- `npm run verify:critical-flows`: smoke tests for health, auth, chat history, memory, settings, providers, tasks, cronjobs

Refactorings must not change functional behavior.
