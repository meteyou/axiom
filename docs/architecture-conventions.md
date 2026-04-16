# Architecture Conventions & Guardrails

This document is the **permanent reference** for structure rules, boundary constraints, and verification checks in the OpenAgent monorepo.

Goals:

1. Clear module boundaries between packages and layers
2. Testable, deep modules instead of shallow distribution
3. Stable behavior parity during refactoring

## 1) Package Boundaries

- `packages/core` is the stable, platform-independent boundary.
- `web-backend`, `web-frontend`, and `telegram` consume Core only via `@openagent/core` (no `@openagent/core/src/*` deep imports).
- `core` does not import any platform packages.
- `web-frontend` does not import `web-backend` or `telegram`.
- `telegram` does not import `web-backend` or `web-frontend`.

## 2) Backend Convention

Mandatory layering for modular API domains under `packages/web-backend/src/api/modules/<domain>/`:

```text
route -> controller -> service -> schema/mapper
```

### Responsibilities

- **route**: HTTP wiring, middleware, route registration
- **controller**: Request/response orchestration, error/status mapping
- **service**: Business logic + coordination of Core/Infra
- **schema/mapper**: Validation, DTO mapping, transport transformation

`app.ts` uses canonical module routes for migrated domains:

- `api/modules/settings/route.ts`
- `api/modules/providers/route.ts`
- `api/modules/memory/route.ts`
- `api/modules/tasks/route.ts`

## 3) Core Deep Modules

- Agent runtime is encapsulated via `createAgentRuntime`/`AgentRuntimeBoundary`.
- Task runtime is encapsulated via `createTaskRuntime`/`TaskRuntimeBoundary`.
- Integrations (e.g., Heartbeat, Consolidation Scheduler, Task Tools) use boundary contracts instead of low-level wiring.

## 4) Frontend Convention

- `pages/` orchestrates only.
- Feature logic lives in `features/`.
- HTTP/transport logic lives in `api/`.

## 5) Enforceable Rules

Rules are enforced via `eslint.boundaries.config.js`:

- Package boundaries
- Backend layer boundaries (`route/controller/service/schema|mapper`)
- Frontend layer boundaries (`pages/features/api`)
- Prohibition of legacy backend adapter imports (`routes/settings|providers|memory|tasks`)

Lint command:

```bash
npm run lint:boundaries
```

## 6) Verification Baseline

Mandatory checks for refactoring and major structural changes:

```bash
npm run baseline:unit
npm run baseline:api
npm run verify:critical-flows
```

Full execution locally:

```bash
npm run baseline:parity
```

### Baseline Segments

- `baseline:unit`: Core + Telegram unit/module tests + Frontend utility/composable tests
- `baseline:api`: Backend API/transport test suite
- `verify:critical-flows`: Smoke/critical flows (Health, Auth/Login, Chat History, Memory, Settings, Providers, Tasks, Cronjobs)

## 7) CI Integration

Workflow: `.github/workflows/ci-guardrails.yml`

The workflow runs on `pull_request` (against `main`) and `push` to `main` and executes:

1. `npm run lint:boundaries`
2. `npm run baseline:unit`
3. `npm run baseline:api`
4. `npm run verify:critical-flows`

## 8) PR Checklist (Definition of Done)

- Structural changes follow the conventions in this document.
- Boundary linting is passing.
- Unit/API/Critical-Flow baseline is passing.
- No unintended functional behavior changes (Behavior Parity).
