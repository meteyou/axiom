# OpenAgent — Agent Guidelines

## Skills

- **Design decisions** (UI/UX, styling, component look & feel): Load the `nura-design` skill.
- **Architecture decisions** (module structure, refactoring, testability): Load the `improve-codebase-architecture` skill.

## Project Structure

- `packages/core` — Shared core logic
- `packages/web-backend` — Backend API server
- `packages/web-frontend` — Nuxt 3 frontend (see `packages/web-frontend/AGENTS.md` for frontend-specific guidelines)
- `packages/telegram` — Telegram bot integration

## Memory System Architecture

The agent has a file-based memory system under `/data/memory/`. There are two separate "AGENTS.md" concepts — do not confuse them:

- **This file** (`AGENTS.md` in the repo root) — Developer/CI guidelines for coding agents working on the codebase. Not visible to the runtime agent.
- **`/data/memory/AGENTS.md`** (runtime) — User-editable behavior rules the agent follows at runtime. Editable via the web UI Memory page.

### Where rules belong

| Rule type | Where | Why |
|-----------|-------|-----|
| Hardcoded tool behavior (e.g. "prefer edit_file over write_file") | System prompt (`assembleSystemPrompt` in `core/src/memory.ts`) | Cannot be accidentally deleted by user |
| User-editable behavior rules (e.g. "ask before destructive changes") | `/data/memory/AGENTS.md` template | User can customize |
| Personality and tone | `/data/memory/SOUL.md` | User can customize |
| Learned facts, project context | `/data/memory/MEMORY.md` | Agent writes over time |
| Per-user info (name, location, preferences) | `/data/memory/users/<username>.md` | Agent learns per user |
| Central settings (language, timezone) | Settings page / `settings.json` | Single source of truth, not duplicated in profiles |

### Avoid duplication

- **Language** and **timezone** live only in Settings — not in user profiles or AGENTS.md.
- **Tool usage instructions** for built-in tools go in the system prompt — not in AGENTS.md.
- **User-specific data** goes in user profiles — not in MEMORY.md.
