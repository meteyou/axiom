<p align="center">
  <strong>Axiom</strong>
</p>

<p align="center">
  <a href="https://github.com/meteyou/axiom/releases"><img alt="Release" src="https://img.shields.io/github/v/release/meteyou/axiom?style=flat-square" /></a>
  <a href="https://github.com/meteyou/axiom/actions"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/meteyou/axiom/ci-guardrails.yml?style=flat-square&branch=main" /></a>
  <a href="https://github.com/meteyou/axiom/pkgs/container/axiom"><img alt="Container" src="https://img.shields.io/badge/ghcr.io-meteyou%2Faxiom-blue?style=flat-square&logo=docker" /></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/github/license/meteyou/axiom?style=flat-square" /></a>
</p>

<p align="center">
  <em>There are many agents, but this one is mine.</em><br/>
  Inspired by <a href="https://pi.dev">pi.dev</a>.
</p>

---

Axiom is a self-hosted, file-first AI agent you can shape into your own. It combines a minimal TypeScript core with practical interfaces — a web UI, a Telegram bot, and a clean REST/WebSocket API — while leaving room for extension and personal shaping through skills, memory, and pluggable LLM providers.

The goal is not just a capable assistant, but an agent that adapts to *one person's* way of thinking, building, and working — shaped by use, improved through iteration, aligned with the needs of its user.

**Axiom is not only what it is built on. It is also what you make of it.**

## Table of Contents

- [Quick Start](#quick-start)
- [Documentation](#documentation)
  - [Getting Started](#getting-started)
  - [Core Concepts](#core-concepts)
  - [Interfaces](#interfaces)
  - [Reference](#reference)
- [Architecture](#architecture)
- [Development](#development)
- [Releasing](#releasing)
- [License](#license)

---

## Quick Start

```bash
mkdir axiom && cd axiom
curl -O https://raw.githubusercontent.com/meteyou/axiom/main/docker-compose.yml
curl -O https://raw.githubusercontent.com/meteyou/axiom/main/.env.example
mv .env.example .env
```

Set the three required secrets in `.env`:

```env
ADMIN_PASSWORD=choose-a-strong-password
JWT_SECRET=$(openssl rand -hex 32)         # paste the literal output
ENCRYPTION_KEY=$(openssl rand -hex 32)     # paste the literal output — back this up!
```

Then:

```bash
docker compose up -d
```

Axiom is now running at [http://localhost:3000](http://localhost:3000). Log in as `admin` with the password you chose, add an LLM provider under **Settings → Providers**, and start chatting.

The full walk-through with troubleshooting lives in [`docs/guide/quickstart.md`](docs/guide/quickstart.md).

### Pinning a version

`docker-compose.yml` uses the `latest` tag by default. Pin a specific release:

```yaml
image: ghcr.io/meteyou/axiom:0.15.1
```

The `edge` tag always tracks the latest `main` commit and may be unstable — use at your own risk.

---

## Documentation

The full user-facing docs live in [`docs/`](docs/) and are designed to be read directly on GitHub. They are also built into a VitePress site (`npm run docs:dev`) and surfaced to the running agent — so when you ask the agent *"how do I configure providers?"* it reads the same files you would.

### Getting Started

- [**Quickstart**](docs/guide/quickstart.md) — Five-minute Docker setup with troubleshooting.
- [**Configuration**](docs/guide/configuration.md) — The three config layers (env vars, JSON files, encrypted secrets) and what belongs where.
- [**LLM Providers**](docs/guide/providers.md) — Connect OpenAI, Anthropic, OpenAI-compatible APIs, or local Ollama.

### Core Concepts

- [**Memory System**](docs/guide/memory.md) — File-based memory: `SOUL`, `MEMORY`, daily notes, user profiles, and the agent-maintained wiki. Plain Markdown, all the way down.
- [**Skills**](docs/guide/skills.md) — Built-in skills with auto-update via semver, plus skills the agent writes for itself.
- [**Tasks & Cronjobs**](docs/guide/tasks-and-cronjobs.md) — Background jobs, scheduled work, one-shot reminders.
- [**Built-in Tools**](docs/guide/tools.md) — `web_search`, `web_fetch`, `transcribe_audio`, and how to enable / disable each.

### Interfaces

- [**Web UI**](docs/guide/web-ui.md) — The Nuxt 3 frontend: Chat, Memory, Settings, Tasks, Sessions, Usage.
- [**Telegram Bot**](docs/guide/telegram.md) — Same agent, same memory, available on your phone.

### Reference

- [**Environment Variables**](docs/reference/env-vars.md) — Every `process.env.*` Axiom reads.
- [**`settings.json`**](docs/reference/settings.md) — Schema and defaults for the runtime settings file.
- [**File Paths**](docs/reference/file-paths.md) — Layout of `/data`, `/workspace`, and `/app` inside the container.

---

## Architecture

This is a TypeScript monorepo. All packages share the same version number.

```
packages/
├── core/           # Shared core logic (memory, sessions, skills, providers, tools)
├── web-backend/    # Express + WebSocket API server
├── web-frontend/   # Nuxt 3 single-page app
└── telegram/       # Telegram bot integration
```

Contributor-facing architecture and design notes live in [`agent_docs/`](agent_docs/) — separate from the user-facing `docs/` so they don't bloat the public site or the runtime agent's prompt:

- [`agent_docs/architecture-conventions.md`](agent_docs/architecture-conventions.md) — package boundaries, backend/frontend layering, verification commands.
- [`agent_docs/session-id-architecture.md`](agent_docs/session-id-architecture.md) — session ID design and conventions.
- [`agent_docs/skill-versioning.md`](agent_docs/skill-versioning.md) — built-in skill versioning mechanism.

Run the architecture baseline:

```bash
npm run baseline:parity
```

The same checks run in CI on every PR (`.github/workflows/ci-guardrails.yml`).

---

## Development

### Prerequisites

- Node.js 22+
- npm

### Setup

```bash
npm install
npm run build
npm run dev
```

### Useful scripts

| Script | What it does |
|---|---|
| `npm run dev` | Run the full stack locally (backend + frontend) |
| `npm run dev:backend` | Backend only |
| `npm run dev:frontend` | Frontend only |
| `npm test` | Run the full vitest suite |
| `npm run lint` | ESLint across all packages |
| `npm run baseline:parity` | Architecture guardrails + critical-flow tests |
| `npm run docs:dev` | Run the VitePress docs site locally on port 5173 |
| `npm run docs:build` | Build the static docs site |

### Coding-agent guidelines

If you (or your coding agent) work on this repo, read [`AGENTS.md`](AGENTS.md) first — it's the developer-facing contract for how to make changes here. Skills under [`.pi/skills/`](.pi/skills/) provide opinionated workflows for design and architecture decisions.

---

## Releasing

This is a monorepo — all five `package.json` files share the same version. The full release flow is documented in [`AGENTS.md`](AGENTS.md#versioning--releases). The short version:

```bash
# 1. Bump version in all 5 package.json files
# 2. Commit
git commit -am "chore: bump version to X.Y.Z"
# 3. Tag and push
git tag vX.Y.Z && git push && git push --tags
# 4. Release on GitHub
gh release create vX.Y.Z --generate-notes --latest
```

The GitHub Actions workflow builds and pushes the Docker image to `ghcr.io/meteyou/axiom`:

| Git Tag  | Docker Tags                       |
|----------|-----------------------------------|
| `v0.2.0` | `0.2.0`, `0.2`, `0`, `latest`     |
| `v1.0.0` | `1.0.0`, `1.0`, `1`, `latest`     |

---

## License

MIT — see [LICENSE](LICENSE).
