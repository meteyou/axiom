# Skills

> **This page is a stub.** Full content will be written together with the agent.

Skills are self-contained capability packages the agent loads on demand. Two flavors:

- **Built-in skills** — ship inside the Docker image under `/app/skills_agent_defaults/`, seeded to `/data/skills_agent/` on first startup, and **auto-updated** via semver in the skill's frontmatter (`version: 1.2.0`). See [`agent_docs/skill-versioning.md`](https://github.com/meteyou/axiom/blob/main/agent_docs/skill-versioning.md) for the update mechanism.
- **Agent-created skills** — the agent can write its own SKILL.md files into `/data/skills_agent/<name>/SKILL.md` and they appear in the next conversation's `<available_skills>` list automatically.

User-managed skills (frontmatter `managed: false`) are never overwritten by image upgrades — your customizations are safe.

---

*To be expanded: SKILL.md frontmatter spec, installation flows (UI, CLI, Git), discovery rules, scoping, attached vs. autoloaded skills, the `wiki` built-in walk-through, troubleshooting "why didn't my skill load".*
