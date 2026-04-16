# OpenAgent

> **There are many agents, but this one is mine.**  
> *Inspired by [pi.dev](https://pi.dev)*

OpenAgent is not just an AI agent platform. It is a foundation for building an agent that becomes truly your own through
customization, memory, workflow integration, and continued collaboration.

It combines a minimal core with practical interfaces like the web UI and Telegram, while leaving room for extension,
refinement, and personal shaping. The goal is not only to provide a capable assistant, but to enable an agent that can
adapt to one person’s way of thinking, building, and working.

Over time, an agent should become more than a generic tool. It should become a reliable working partner. Shaped by use,
improved through iteration, and aligned with the needs of its user.

**OpenAgent is not only what it is built on. It is also what you make of it.**

## Quick Start with Docker

### 1. Create environment file

```bash
cp .env.example .env
```

Edit `.env` and set the required variables:

```env
ADMIN_PASSWORD=your-secure-password
JWT_SECRET=your-jwt-secret
# ENCRYPTION_KEY=optional-encryption-key
# HOST_PORT=3000
```

### 2. Start the container

```bash
docker compose up -d
```

OpenAgent will be available at `http://localhost:3000`.

### Pin a specific version

By default, the `latest` tag is used. To pin a specific version, edit `docker-compose.yml`:

```yaml
image: ghcr.io/meteyou/openagent:0.1.0
```

### Use the edge image

The `edge` tag always reflects the latest `main` branch commit:

```yaml
image: ghcr.io/meteyou/openagent:edge
```

> **Warning:** Edge builds may be unstable — use at your own risk.

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

### Project Structure

```
packages/
├── core/           # Shared core logic
├── web-backend/    # Backend API server
├── web-frontend/   # Nuxt 3 frontend
└── telegram/       # Telegram bot integration
```

### Architecture Guardrails

Structural conventions, boundary rules and the verification baseline are documented in:

- `docs/architecture-conventions.md`

Run the full guardrail baseline locally:

```bash
npm run baseline:parity
```

The same checks run in CI for pull requests and `main` via:

- `.github/workflows/ci-guardrails.yml`

## Releasing a New Version

1. Update the version in `package.json`
2. Create and push a git tag:

```bash
git tag v0.2.0
git push origin v0.2.0
```

The GitHub Actions workflow will automatically build and push the Docker image to `ghcr.io/meteyou/openagent` with the following tags:

| Git Tag   | Docker Tags                              |
| --------- | ---------------------------------------- |
| `v0.2.0`  | `0.2.0`, `0.2`, `0`, `latest`           |
| `v1.0.0`  | `1.0.0`, `1.0`, `1`, `latest`           |

## License

See [LICENSE](LICENSE) for details.
