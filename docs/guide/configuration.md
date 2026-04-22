# Configuration

Axiom has three configuration layers. Knowing which lives where saves a lot of debugging time.

## The three layers

| Layer | Where | Edited by | Persistence |
|---|---|---|---|
| **Environment variables** | `.env` / Compose `environment:` | You, before `docker compose up` | Restart container to apply |
| **Config files (JSON)** | `/data/config/*.json` inside the container | The web UI (Settings page) and the agent | Hot-reloaded by the backend |
| **Encrypted secrets** | `/data/config/secrets.json` | The web UI; values are AES-256-GCM encrypted | Hot-reloaded; injected into `process.env` |

Memory and per-user state live in a separate tree under `/data/memory/` — see [Memory System](./memory).

## Environment variables

Set these in `.env` (read by `docker compose`) or directly in the Compose file. They are read **once at startup**.

The required ones for any non-toy deployment:

```bash
ADMIN_PASSWORD=...        # web UI login password
JWT_SECRET=...            # signs session tokens
ENCRYPTION_KEY=...        # encrypts secrets.json at rest
```

The full reference, including optional ones (`HOST_PORT`, `TZ`, `WORKSPACE_DIR`, `DATA_DIR`, `FRONTEND_DIR`, `GITHUB_TOKEN`, …), lives in [Environment Variables](../reference/env-vars).

### Why `ENCRYPTION_KEY` matters

Provider API keys, Telegram bot tokens, and any other sensitive values you enter in the web UI are written to `/data/config/secrets.json` **encrypted with `ENCRYPTION_KEY`** (AES-256-GCM).

- If `ENCRYPTION_KEY` is **not set**, Axiom falls back to a built-in default key. **Do not run a real deployment that way** — anyone with read access to the volume could decrypt your keys.
- If you **change** `ENCRYPTION_KEY`, all previously encrypted secrets become unreadable on next startup. They are silently skipped (logged as `Failed to decrypt secret …`) and you need to re-enter them in the UI.

Generate a strong key with:

```bash
openssl rand -hex 32
```

Back it up out-of-band (password manager, secret store) so you can restore the volume on a different host without losing your provider keys.

## Config files (`/data/config/`)

On first startup the entrypoint creates the following files with safe defaults if they don't exist yet:

| File | Contents |
|---|---|
| `providers.json` | LLM provider definitions, models, default model per provider |
| `settings.json` | All non-secret runtime settings (timezone, language, scheduler, batching, token-price tables, …). See [`settings.json` reference](../reference/settings) |
| `telegram.json` | Telegram bot config: token, admin user IDs, polling vs. webhook |
| `skills.json` | Installed skill registry (managed by the skills subsystem) |
| `secrets.json` | Encrypted env vars (created on first secret-write) |
| `AGENTS.md` | User-editable agent rules (loaded into every system prompt) |
| `HEARTBEAT.md` | Recurring agent self-check tasks |
| `CONSOLIDATION.md` | Memory-consolidation rules |

You can edit JSON files directly inside the container (`docker compose exec openagent vi /data/config/providers.json`) but the **web UI is the supported path** — the backend hot-reloads after changes and validates the schema.

## Secrets (`/data/config/secrets.json`)

Anything you set under **Settings → Secrets** in the web UI lands here, encrypted. At startup the backend decrypts every entry and injects it into `process.env`, so:

```bash
# Set in the UI under "Secrets"
GITHUB_TOKEN=ghp_xxxxxxxxxxxx
BRAVE_SEARCH_API_KEY=xxxxxxxx
```

…becomes available to any code that reads `process.env.GITHUB_TOKEN`. This is how features like the Brave search backend or GitHub-API access pick up credentials without you having to bake them into the Compose file.

Use this for any **credential** that the agent or its tools need at runtime. Use Compose `environment:` only for things that must be available **before** the backend boots (the three required vars above).

## Volumes

The Compose file mounts two named volumes:

| Volume | Container path | Purpose |
|---|---|---|
| `axiom-data` | `/data` | Database, config, memory, skills, npm cache. **Back this up.** |
| `axiom-workspace` | `/workspace` | The agent's home directory. Anything the agent writes via the `shell` tool, downloads with `wget`/`yt-dlp`, or saves via `write_file` outside `/data` ends up here. |

If you lose `axiom-data` you lose the database, all memory, all configured providers, and all installed skills. If you lose `axiom-workspace` you lose whatever the agent has been working on — but the agent itself can rebuild that.

For the full directory layout inside both volumes, see [File Paths](../reference/file-paths).

## Hot-reload behavior

| Change | Takes effect |
|---|---|
| `.env` / Compose env vars | After `docker compose up -d` (container restart) |
| Anything in **Settings → …** in the UI | Immediately (no restart) |
| Manual edit of `/data/config/*.json` | Immediately for most settings; restart to be safe |
| Editing `AGENTS.md` / `SOUL.md` / `MEMORY.md` | Picked up on the **next** message (system prompt is rebuilt per turn) |
| Adding/removing skills | Immediately for new skills; the agent sees the updated `<available_skills>` list on the next turn |

## Next steps

- Add an [LLM Provider](./providers) to actually talk to a model.
- Customize the [Memory System](./memory) so the agent learns about you.
- Hook up the [Telegram bot](./telegram) for mobile access.
