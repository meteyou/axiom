---
name: wiki
description: Maintain and search the personal LLM-Wiki (knowledge base of Markdown pages). Use this skill for ingesting new sources, querying the wiki, and wiki maintenance/linting.
---

# Wiki Skill

The wiki lives at `/data/memory/wiki/`. It is a collection of LLM-maintained Markdown files — a personal knowledge base following the Karpathy pattern.

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

Goal: extract knowledge from an external source (URL, file, conversation context) and store it in the wiki.

**Steps:**

1. List all existing wiki pages via `list_files /data/memory/wiki/`:
   - Which pages already exist?
   - Is there an existing page that should be extended?

2. Extract the essential knowledge from the source:
   - Facts, concepts, decisions, dependencies
   - No duplication of existing knowledge
   - Focus on evergreen knowledge (durably useful, not ephemeral)

3. Decide: create a new page or extend an existing one?
   - New page: when it covers a new topic, project, or concept
   - Existing page: when the knowledge belongs to an existing page

4. Write the page:
   - Filename: `topic-name.md` (lowercase, hyphens instead of spaces)
   - First heading `# Title` (clear and precise)
   - Structure: headings, bullet lists, code blocks where appropriate
   - Cross-links: reference related wiki pages (`[Page Name](page-name.md)`)

**Example — ingest a web article:**
```
1. web_fetch the URL
2. list_files /data/memory/wiki/
3. Extract relevant knowledge, identify duplicates
4. write_file /data/memory/wiki/topic.md with the distilled knowledge
```

**Example — ingest context from a conversation:**
```
1. list_files /data/memory/wiki/
2. Check whether a matching page exists
3. If yes: edit_file to add a section
4. If no: write_file to create a new page
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

Goal: audit the wiki for quality — find contradictions, orphaned pages, missing links.

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

5. **Write a lint report:**
   - Append findings to today's daily file:
     ```
     append to /data/memory/daily/YYYY-MM-DD.md
     ## Wiki Lint Report — YYYY-MM-DD\n\n### Findings\n- ...
     ```

6. **Apply fixes:**
   - Apply obvious corrections directly (edit_file)
   - Only when certain — no speculative changes

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
- Today's daily file (for lint reports): `/data/memory/daily/YYYY-MM-DD.md`
- Always use absolute paths
