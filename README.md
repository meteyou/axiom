# OpenAgent

An AI agent platform with web interface and Telegram integration.

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
