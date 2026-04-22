# File Paths

Authoritative layout of the directories Axiom uses. Useful when debugging volumes, planning backups, or asking the agent "where is X stored?".

## Inside the container

| Path | Volume | Contents |
|---|---|---|
| `/app/` | (image) | Axiom source + built code. Read-only at runtime. |
| `/app/README.md` | (image) | Main project README, surfaced to the agent via `<project_docs>`. |
| `/app/docs/` | (image) | User-facing documentation (this site). Surfaced to the agent. |
| `/app/agent_docs/` | (image) | Contributor / internals docs. **Not** surfaced to the agent. |
| `/app/skills_agent_defaults/` | (image) | Built-in skill defaults, seeded to `/data/skills_agent/` on first run. |
| `/data/` | `axiom-data` | Persistent app state. **Back this up.** |
| `/data/db/` | `axiom-data` | SQLite database (sessions, messages, tasks, facts). |
| `/data/config/` | `axiom-data` | Runtime config: providers, settings, secrets, telegram, AGENTS.md, HEARTBEAT.md, CONSOLIDATION.md. |
| `/data/memory/` | `axiom-data` | All memory files: SOUL, MEMORY, daily/, users/, wiki/, sources/. See [Memory System](../guide/memory). |
| `/data/skills/` | `axiom-data` | User-installed skills (URL-installed, manually uploaded). |
| `/data/skills_agent/` | `axiom-data` | Built-in agent skills (auto-updated) + agent-created skills. |
| `/data/uploads/` | `axiom-data` | User-uploaded files (cleaned per `uploads.retentionDays`). |
| `/data/npm-global/` | `axiom-data` | npm global prefix — survives container upgrades. |
| `/workspace/` | `axiom-workspace` | Agent's home directory. Anything the agent writes via `shell` or `write_file` outside `/data`. |

## On the host

The two named volumes live wherever Docker keeps them — usually:

```
/var/lib/docker/volumes/axiom-data/_data/
/var/lib/docker/volumes/axiom-workspace/_data/
```

To browse them as your host user, `sudo` in or temporarily bind-mount them under a folder you own.

---

*To be expanded: backup/restore recipes (tar a snapshot of `/data` while the container is paused), volume migration to a new host, sizing guidance, what's safe to delete to reclaim space.*
