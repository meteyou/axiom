---
name: wiki
version: 1.0.0
description: Maintain and search the personal LLM-Wiki (knowledge base of Markdown pages). Use this skill for ingesting new sources, querying the wiki, and wiki maintenance/linting.
---

# Wiki Skill

The wiki lives at `/data/memory/wiki/`. It is a collection of LLM-maintained Markdown files — a personal knowledge base following the Karpathy pattern.

## Three-Layer Architecture

| Layer | Path | Mutability | Purpose |
|---|---|---|---|
| Sources (raw) | `/data/memory/sources/` | Immutable — add only | Archived raw material: articles, transcripts, papers |
| Wiki (distilled) | `/data/memory/wiki/` | LLM-maintained | Summary pages, concepts, cross-references |
| Schema / rules | `/data/config/CONSOLIDATION.md` + this skill | Editable | How the wiki operates |

Rule of thumb: **Sources are what you read. Wiki is what you learned.** Never edit sources; always cite them from wiki pages.

## Wiki Structure

Each wiki page is a `.md` file under `/data/memory/wiki/`. Pages can have optional YAML frontmatter with aliases:

```markdown
---
aliases: [short-name, abbreviation]
---

# Page Title

Page content...
```

## Operations

### Ingest — Add a new source

Goal: extract knowledge from an external source (URL, file, conversation context), **archive the raw material** under `sources/`, and distill the knowledge into the wiki.

**Steps:**

1. **Fetch the raw source.** `web_fetch` the URL, read the transcript, or capture the conversation snippet.

2. **Archive the raw source under `sources/`** (skip only if the content is trivial or already archived):
   - Choose subfolder: `articles/`, `youtube/`, `podcasts/`, `papers/`, `notes/`
   - Filename: `<yyyy-mm-dd>-<slug>.md` (lowercase, hyphens)
   - First block: YAML frontmatter with `source_type`, `url`, `author`, `captured`
   - Body: the raw text as received — no interpretation, no editing
   - **Never modify an existing source file.** If the source itself changes, add a new dated file.

3. **List existing wiki pages** via `list_files /data/memory/wiki/`:
   - Which pages already exist?
   - Is there an existing page that should be extended?

4. **Extract the essential knowledge** from the source:
   - Facts, concepts, decisions, dependencies
   - No duplication of existing knowledge
   - Focus on evergreen knowledge (durably useful, not ephemeral)

5. **Decide: create a new page or extend an existing one?**
   - New page: when it covers a new topic, project, or concept
   - Existing page: when the knowledge belongs to an existing page

6. **Write the page:**
   - Filename: `topic-name.md` (lowercase, hyphens instead of spaces)
   - First heading `# Title` (clear and precise)
   - Structure: headings, bullet lists, code blocks where appropriate
   - Cross-links: reference related wiki pages (`[Page Name](page-name.md)`)
   - **Add a `## Quellen` / `## Sources` section** citing the `sources/...` file you just archived, so the page remains verifiable.

**Example — ingest a web article:**
```
1. web_fetch the URL
2. write_file /data/memory/sources/articles/2026-04-17-<slug>.md (raw text, with frontmatter)
3. list_files /data/memory/wiki/
4. Extract relevant knowledge, identify duplicates
5. write_file or edit_file /data/memory/wiki/topic.md with distilled knowledge + ## Quellen pointing to the archived source
```

**Example — ingest context from a conversation:**
```
1. list_files /data/memory/wiki/
2. Check whether a matching page exists
3. If yes: edit_file to add a section
4. If no: write_file to create a new page
(No sources/ archive needed when the "source" is just conversational context.)
```

---

### Query — Search the wiki

Goal: search the wiki for knowledge relevant to a current task.

**Steps:**

1. `list_files /data/memory/wiki/` — list all pages
2. Scan filenames: which pages might be relevant?
3. Read relevant pages with `read_file`
4. If a page links to others (`[Name](file.md)`): read those too

**Tips:**
- Broad topics: read multiple pages, then synthesize
- Specific questions: read one or two targeted pages
- If no matching page exists: inform the user and offer to create one

**When to use the wiki:**
- Before answering technical questions about known projects or systems
- For recurring topics (tools, workflows, configurations)
- When the user asks "how do we normally do X?"

---

### Lint — Wiki health check

Goal: audit the wiki for quality — find contradictions, orphaned pages, missing links, **and surface content gaps the wiki implies but does not cover**.

**Steps:**

1. **Read all pages:**
   ```
   list_files /data/memory/wiki/
   read_file each page
   ```

2. **Find contradictions:**
   - Same facts described differently across pages?
   - Outdated information that should be corrected?
   - Duplicates (same knowledge on multiple pages)?

3. **Identify orphaned pages:**
   - Which pages are not linked from any other page?
   - Are they still valuable as standalone documents?

4. **Find missing cross-links:**
   - Concepts mentioned on page A for which page B exists — but no link?
   - Add cross-links with `edit_file`

5. **Surface content gaps** (Karpathy/AI-Maker-Lab pattern):
   - Which concepts, people, projects, or tools are **referenced repeatedly across pages but have no dedicated page**?
   - Which pages contain TODO markers, "unclear", "to verify", or open questions?
   - Which topics are discussed in daily files across multiple sessions but never promoted to a wiki page?
   - List these as **suggested next research directions** — do not auto-create pages, just propose.

6. **Check source coverage:**
   - Wiki pages that make factual claims but have no `## Quellen` / `## Sources` section — flag them.
   - `sources/` files with no inbound wiki reference — either unused raw material or candidate for ingest.

7. **Write a lint report:**
   - Append findings to today's daily file:
     ```
     append to /data/memory/daily/YYYY-MM-DD.md
     ## Wiki Lint Report — YYYY-MM-DD\n\n### Findings\n- ...
     ```

8. **Apply fixes:**
   - Apply obvious corrections directly (edit_file)
   - Only when certain — no speculative changes
   - Gap suggestions are reported only, not auto-resolved

**Lint report format:**
```markdown
## Wiki Lint Report — 2025-01-15

### Contradictions
- `project-x.md` and `architecture.md` describe the database structure differently

### Orphaned pages
- `old-service.md` — not linked from anywhere, consider deleting?

### Missing cross-links
- `deployment.md` mentions Docker but no link to `docker.md`

### Outdated information
- `setup.md` still references Node 16, current version is Node 20

### Content gaps (suggested next research)
- `llm-oekosystem.md` mentions Qwen3.6 repeatedly but no dedicated `qwen.md`
- Multiple daily entries reference "news crawler" but no wiki page exists

### Source coverage
- `project-x.md` makes release-date claims but has no ## Quellen section
- `sources/articles/2026-04-17-foo.md` archived but not cited from any wiki page
```

---

## Filename conventions

- Lowercase: `my-project.md` not `MyProject.md`
- Hyphens instead of spaces: `api-design.md`
- Descriptive and unambiguous: `openagent-deployment.md` rather than `deployment.md` when multiple projects exist
- No special characters except `-` and `_`

## Quality principles (after Karpathy)

1. **Each piece of knowledge lives in exactly one place** — no copy-paste between pages, use cross-links instead
2. **Short and precise** — wiki pages are reference material, not prose
3. **Always current** — correct outdated info, don't just add new info on top
4. **Interlinked** — wiki pages should reference each other to form a network
5. **Evergreen** — ephemeral info belongs in daily files, not the wiki

## Paths

- Wiki directory: `/data/memory/wiki/`
- Sources directory (immutable raw material): `/data/memory/sources/`
- Today's daily file (for lint reports): `/data/memory/daily/YYYY-MM-DD.md`
- Always use absolute paths
