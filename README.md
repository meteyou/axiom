# Axiom

> **There are many agents, but this one is mine.**  
> *Inspired by [pi.dev](https://pi.dev)*

Axiom is a self-hosted, file-first AI agent you can shape into your own. It combines a minimal TypeScript core with practical interfaces — a web UI, a Telegram bot, and a clean REST/WebSocket API — while leaving room for extension and personal shaping through skills, memory, and pluggable LLM providers.

The goal is not just a capable assistant, but an agent that adapts to *one person's* way of thinking, building, and working — shaped by use, improved through iteration, aligned with the needs of its user.

**Axiom is not only what it is built on. It is also what you make of it.**

---

## 📚 Documentation

The full documentation lives at **[axiom.meteyou.tech](https://axiom.meteyou.tech)**.

- [**Quickstart**](https://axiom.meteyou.tech/guide/quickstart) — Five-minute Docker setup.
- [**Configuration**](https://axiom.meteyou.tech/guide/configuration) — Env vars, JSON files, and encrypted secrets.
- [**Core Concepts**](https://axiom.meteyou.tech/concepts/) — Memory, skills, tools, tasks, system prompt.
- [**Web Interface**](https://axiom.meteyou.tech/web-ui/) — Chat, Memory, Tasks, Sessions, Usage.
- [**Telegram Bot**](https://axiom.meteyou.tech/guide/telegram) — Same agent, on your phone.
- [**Reference**](https://axiom.meteyou.tech/reference/) — Environment variables, `settings.json`, file paths.

> The same docs are surfaced to the running agent via its system prompt — so when you ask the agent *"how do I configure providers?"* it reads the same pages you would.

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

The full walk-through with troubleshooting lives at [axiom.meteyou.tech/guide/quickstart](https://axiom.meteyou.tech/guide/quickstart).

### Pinning a version

`docker-compose.yml` uses the `latest` tag by default. Pin a specific release:

```yaml
image: ghcr.io/meteyou/axiom:0.17.0
```

The `edge` tag always tracks the latest `main` commit and may be unstable — use at your own risk.

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

Contributor-facing architecture and design notes live in [`agent_docs/`](agent_docs/) — separate from the user-facing docs so they don't bloat the public site or the runtime agent's prompt:

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

| Script                    | What it does                                     |
|---------------------------|--------------------------------------------------|
| `npm run dev`             | Run the full stack locally (backend + frontend)  |
| `npm run dev:backend`     | Backend only                                     |
| `npm run dev:frontend`    | Frontend only                                    |
| `npm test`                | Run the full vitest suite                        |
| `npm run lint`            | ESLint across all packages                       |
| `npm run baseline:parity` | Architecture guardrails + critical-flow tests    |
| `npm run docs:dev`        | Run the VitePress docs site locally on port 5173 |
| `npm run docs:build`      | Build the static docs site                       |

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
