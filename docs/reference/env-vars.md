# Environment Variables

Reference for every environment variable Axiom reads. Set these in `.env`, your Compose file, or your container orchestrator. They are evaluated **once at startup** — restart the container to apply changes.

For credentials that are added at runtime via the web UI (provider API keys, Brave Search key, etc.), see [Configuration → Secrets](../guide/configuration#secrets-data-config-secrets-json) instead.

## Required

These three must be set for any non-development deployment.

| Variable | Default | Description |
|---|---|---|
| `ADMIN_PASSWORD` | _(none — required)_ | Login password for the web UI admin user. The Compose file enforces this with `${ADMIN_PASSWORD:?ADMIN_PASSWORD must be set}`. |
| `JWT_SECRET` | `axiom-dev-secret-change-me` (dev fallback) | HMAC secret used to sign JWT session tokens. **Change this in production.** Generate with `openssl rand -hex 32`. |
| `ENCRYPTION_KEY` | _(insecure dev key)_ | AES-256-GCM key used to encrypt `/data/config/secrets.json`. Accepts either a 64-char hex string (used as-is) or any other string (used to derive a key via `scrypt`). **If you change or lose it, all stored API keys become unrecoverable.** Generate with `openssl rand -hex 32`. |

## Networking

| Variable | Default | Description |
|---|---|---|
| `HOST` | `0.0.0.0` | Interface the backend binds to. Inside Docker, leave at `0.0.0.0`. |
| `PORT` | `3000` | Port the backend listens on inside the container. |
| `HOST_PORT` | `3000` | (Compose-only) Host-side port mapped to the container's `3000`. Set this if `3000` is already taken on the host. |

## Storage

| Variable | Default | Description |
|---|---|---|
| `DATA_DIR` | `/data` | Root directory for the database, config, memory, and skills. The Compose file maps the `axiom-data` volume here. |
| `WORKSPACE_DIR` | `/workspace` | Agent's home / working directory. The Compose file maps the `axiom-workspace` volume here. If unset, falls back to `<DATA_DIR>/workspace` then to `/workspace`. |

## Optional features

| Variable | Default | Description |
|---|---|---|
| `ADMIN_USERNAME` | `admin` | Login username for the admin user. Rarely changed. |
| `TZ` | _(unset; container UTC)_ | Linux timezone for cron evaluation, daily-memory file naming, and log timestamps. The default Compose file sets `Europe/Vienna` — override per deployment. |
| `NODE_ENV` | _(unset)_ | Set to `production` in the default Compose file. Controls Nuxt/Express behavior; rarely needs changing. |
| `FRONTEND_DIR` | _(auto-detected)_ | Override the path where the backend looks for the built Nuxt frontend. Only useful for custom builds where `web-frontend/dist` isn't where the backend expects it. |
| `GITHUB_TOKEN` | _(unset)_ | When set, used as `Authorization: token <value>` for skill downloads from GitHub (avoids unauthenticated rate limits when installing many skills from public repos). |
| `AXIOM_PROJECT_DIR` | _(auto-detected)_ | Overrides the resolved repo root for `getDocsPath()`/`getReadmePath()`/`getAgentDocsPath()`. Only needed for unusual deployments where source files don't live next to the running code (e.g. read-only image overlays). |

## Compose-file convention

The default `docker-compose.yml` reads environment variables from `.env` in the **current working directory** (where you run `docker compose up`). The pattern looks like:

```yaml
environment:
  - ADMIN_PASSWORD=${ADMIN_PASSWORD:?ADMIN_PASSWORD must be set}
  - JWT_SECRET=${JWT_SECRET:?JWT_SECRET must be set}
  - ENCRYPTION_KEY=${ENCRYPTION_KEY:-}
```

- `${VAR:?message}` — required; Compose refuses to start if missing.
- `${VAR:-default}` — optional with a default (empty string in the example for `ENCRYPTION_KEY`, which means "fall back to the insecure dev key" — fine for trying things out, **not for production**).

## Example `.env`

```bash
# --- Required ---
ADMIN_PASSWORD=$(openssl rand -base64 24)
JWT_SECRET=$(openssl rand -hex 32)
ENCRYPTION_KEY=$(openssl rand -hex 32)

# --- Networking ---
HOST_PORT=3000

# --- Optional ---
TZ=Europe/Vienna
ADMIN_USERNAME=admin
GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx
```

> The `$(openssl rand …)` syntax is shown for clarity — `.env` files are **not** evaluated by a shell. Run the commands first and paste the literal values into the file.
