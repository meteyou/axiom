# Quickstart

Get Axiom running in under five minutes with Docker.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and [Docker Compose](https://docs.docker.com/compose/install/) (Docker Desktop on macOS/Windows already includes both)
- An LLM API key (OpenAI, Anthropic, or any OpenAI-compatible provider). You can also point at a local [Ollama](https://ollama.com) instance.

## 1. Get the Compose file

Axiom ships as a single Docker image (`ghcr.io/meteyou/axiom`) plus a `docker-compose.yml` that wires up the data volumes and required environment variables.

```bash
mkdir axiom && cd axiom
curl -O https://raw.githubusercontent.com/meteyou/axiom/main/docker-compose.yml
curl -O https://raw.githubusercontent.com/meteyou/axiom/main/.env.example
mv .env.example .env
```

## 2. Set the required secrets

Edit `.env` and set at least these three values:

```bash
ADMIN_PASSWORD=choose-a-strong-password
JWT_SECRET=$(openssl rand -hex 32)
ENCRYPTION_KEY=$(openssl rand -hex 32)
```

| Variable | Purpose |
|---|---|
| `ADMIN_PASSWORD` | Login password for the web UI (username defaults to `admin`). |
| `JWT_SECRET` | Signs session tokens. Anything random and long. |
| `ENCRYPTION_KEY` | Encrypts API keys and provider secrets at rest in `secrets.json`. **If you lose this, stored secrets become unrecoverable.** Back it up. |

For the full list of supported variables, see [Environment Variables](../reference/env-vars).

## 3. Start the container

```bash
docker compose up -d
```

The image will be pulled (~500 MB on first run) and the container will start. Check the logs:

```bash
docker compose logs -f axiom
```

You should see `[axiom] Starting server as agent user…` and shortly after, the server listening on port 3000.

## 4. Open the web UI

Visit [http://localhost:3000](http://localhost:3000) and log in with:

- **Username:** `admin`
- **Password:** the value of `ADMIN_PASSWORD` you set above

## 5. Add an LLM provider

In the web UI, go to **Settings → Providers** and add at least one provider. The minimum you need:

- A **name** (free-form, e.g. `openai`)
- A **type** (`openai`, `anthropic`, `openai-compatible`, …)
- The **API key** (encrypted with `ENCRYPTION_KEY` before being stored)
- At least one **enabled model** (e.g. `gpt-4o-mini` or `claude-sonnet-4-20250514`)

For details on each provider type, see [LLM Providers](./providers).

## 6. Talk to the agent

Open the **Chat** page in the web UI and send your first message. The agent will use the provider you configured.

From here, explore:

- [Memory System](./memory) — how the agent remembers things across conversations
- [Skills](./skills) — extend the agent with reusable capabilities
- [Tasks & Cronjobs](./tasks-and-cronjobs) — let the agent do work in the background
- [Telegram Bot](./telegram) — talk to the agent from your phone

## Pinning a specific version

The default Compose file uses the `latest` tag. To pin a specific version, edit `docker-compose.yml`:

```yaml
services:
  axiom:
    image: ghcr.io/meteyou/axiom:0.15.1
```

See the [GitHub releases](https://github.com/meteyou/axiom/releases) for available versions.

## Updating

```bash
docker compose pull
docker compose up -d
```

Your data is preserved in the `axiom-data` and `axiom-workspace` Docker volumes — see [File Paths](../reference/file-paths) for the layout.

## Troubleshooting

**`ADMIN_PASSWORD must be set`** — `.env` is missing or not loaded. Make sure you are in the directory containing both `.env` and `docker-compose.yml` when running `docker compose up`.

**Cannot reach `http://localhost:3000`** — Check `docker compose ps` to confirm the container is `Up (healthy)`. If you changed `HOST_PORT` in `.env`, use that port instead.

**LLM calls fail** — Verify your provider's API key in **Settings → Providers**. Failed keys show a red warning indicator.

**Encryption errors after upgrade** — If you regenerated `ENCRYPTION_KEY`, all previously stored secrets become undecryptable. Re-enter your provider API keys in the UI.
