# PRD #10 — Repository Guardrails & Baseline

Diese Datei definiert die **verbindliche Refactor-Basis** für die schrittweise Monorepo-Strukturmigration.

Ziele:

1. strukturelle Konventionen für `core`, `web-backend`, `web-frontend` festschreiben,
2. technische Guardrails (Boundary-Linting) aktivieren,
3. eine wiederholbare Paritäts-Baseline für Unit/API/Smoke-Checks etablieren.

> Scope: **Maintainability only**. Keine fachlichen Feature-Änderungen.

---

## 1) Verbindliche Struktur- und Modulkonventionen

## Core (`packages/core`)

Core ist die stabile, plattformunabhängige Boundary.

- Domänenorientierte Module statt wachsender Flat-Cluster.
- Öffentliche Nutzung über stabile Contract-/Barrel-Exports (`index.ts` / domänenspezifische Barrels).
- Keine Abhängigkeit von Plattformpaketen (`web-backend`, `web-frontend`, `telegram`).
- Runtime-/Infra-Details bleiben intern gekapselt.

### Zielbild (inkrementell)

```text
packages/core/src/
  agent/
  config/
    settings/
    providers/
    secrets/
  memory/
  tasks/
  integrations/
  infra/
  contracts/
  index.ts
```

---

## Web Backend (`packages/web-backend`)

Backend-Domänen folgen dem verpflichtenden Layering:

```text
route -> controller -> service -> schema/mapper
```

### Verantwortlichkeiten

- **route**: HTTP-Wiring, Middleware, Route-Registrierung
- **controller**: Request/Response-Orchestrierung, Fehler-/Status-Mapping
- **service**: Fachlogik + Koordination von Core/Infra
- **schema/mapper**: Validierung, DTO-Mapping, Transport-Transformation

### Zielbild (inkrementell)

```text
packages/web-backend/src/
  bootstrap/
  api/
    middleware/
    modules/
      <domain>/
        route/
        controller/
        service/
        schema/
        mapper/
  realtime/
  services/
```

---

## Web Frontend (`packages/web-frontend`)

- **Pages sind Orchestratoren**, keine Feature-Container.
- Feature-Logik wird in `features/` ausgelagert (Components/Composables/Types).
- Transport-/HTTP-Zugriffe gehören in `api/`.
- Wiederverwendbare UI-/Shared-Bausteine in `shared/`.

### Zielbild (inkrementell)

```text
packages/web-frontend/app/
  pages/
  features/
  api/
  shared/
```

---

## 2) Enforceable Boundary-Regeln

Boundary-Linting wird über `eslint.boundaries.config.js` erzwungen.

Aktive Regeln:

1. **Package-Boundaries**
   - `core` darf keine Plattformpakete importieren.
   - `web-frontend` darf nicht von `web-backend`/`telegram` abhängen.
   - `telegram` darf nicht von `web-backend`/`web-frontend` abhängen.
   - `web-backend` darf `telegram` nur als Integrations-Boundary konsumieren (keine Frontend-Kopplung).
   - Deep-Imports in `@openagent/core/src/*` sind verboten (nur Public Boundary verwenden).

2. **Backend-Layer-Boundaries** (für neue Modulstruktur unter `src/api/modules/**`)
   - `route` darf nicht direkt `service`, `schema` oder `mapper` importieren.
   - `controller` darf nicht aus `route` importieren.
   - `service` darf nicht aus `route` oder `controller` importieren.
   - `schema`/`mapper` dürfen nicht aus `route`, `controller`, `service` importieren.

3. **Frontend-Layer-Boundaries** (für neue Struktur)
   - `features` darf nicht aus `pages` importieren.
   - `api` darf nicht aus `pages`, `features`, `components` importieren.

Lint-Kommando:

```bash
npm run lint:boundaries
```

---

## 3) Baseline für Verhalten-Parität (repeatable)

Folgende Baseline-Kommandos sind verbindlich für Refactor-PRs:

```bash
npm run baseline:unit
npm run baseline:api
npm run baseline:smoke
```

### Baseline-Segmente

- `baseline:unit`
  - Core + Telegram Unit/Module-Tests
  - Frontend Utility/Composable-Tests
- `baseline:api`
  - Backend API-/Transport-Test-Suite
- `baseline:smoke`
  - Kritische Flows (Health, Auth/Login, Chat-History, Settings, Providers) via fokussiertem Smoke-Subset

Gesamtausführung:

```bash
npm run baseline:parity
```

---

## 4) CI/Workflow-Integration

Workflow: `.github/workflows/refactor-baseline.yml`

Dieser Workflow führt bei Push/PR aus:

1. `npm run lint:boundaries`
2. `npm run baseline:unit`
3. `npm run baseline:api`
4. `npm run baseline:smoke`

Damit wird jede Migrations-PR früh gegen Boundary-Verletzungen und Verhaltensdrift geprüft.

---

## 5) Definition of Done für PRD-10-Migrations-PRs

- Strukturänderung folgt den Konventionen dieser Datei.
- Boundary-Linting ist grün.
- Unit/API/Smoke-Baseline ist grün.
- Keine fachliche Verhaltensänderung (Behavior Parity).
