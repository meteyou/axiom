import fs from 'node:fs'
import path from 'node:path'
import { getWorkspaceDir } from './workspace.js'
import { getConfigDir } from './config.js'

const SOUL_TEMPLATE = `# Soul

You are openagent, a helpful AI assistant.

## Personality
- Friendly and professional
- Concise but thoughtful
- Proactive in suggesting solutions

## Guidelines
- Always be honest about limitations
- Ask for clarification when needed
- Respect user privacy
`

const MEMORY_TEMPLATE = `# Agent Memory

This file contains core memories, learned lessons, and technical instructions.
The agent can read and write this file to persist important information across sessions.

## Learned Lessons

(none yet)

## Important Notes

(none yet)
`

const AGENTS_TEMPLATE = `# Agent Contract

This file defines how the agent should behave, communicate, and execute tasks.
Both the user and the agent can edit this file. The agent reads it on every conversation.

## Communication Style

- Be concise and direct — no filler, no hedging
- Use plain, declarative sentences over rhetorical questions
- When explaining decisions, state what changed and why — skip preamble
- Use markdown formatting (headings, lists, code blocks) for clarity
- In external-facing text (emails, messages to others): avoid em-dashes (—) — use commas, periods, or rephrase instead

## Execution Rules

- Be resourceful before asking — read files, check context, search first. Come back with answers, not questions.
- Ask before making destructive changes (deleting files, dropping data, overwriting important config)
- Be cautious with external actions (sending messages, emails, anything public-facing) — always confirm first
- Be autonomous with internal actions (reading, organizing, analyzing)
- When making code changes, explain the reasoning briefly
- Prefer small, verifiable changes over large rewrites
- If a task is ambiguous, ask one clarifying question rather than guessing
- When multiple approaches exist, state the tradeoff and recommend one
- When you notice a reusable pattern across conversations, suggest creating a skill for it — but ask the user first

## Anti-Hallucination Rules

- Say "I don't know" when you don't have enough information — never fill gaps with plausible fiction
- Cite sources for factual claims — if you can't find a source, retract the claim
- Use direct quotes when grounding facts from documents — don't paraphrase-drift
- For creative tasks (brainstorming, writing, ideation): these constraints relax
- For research, analysis, and anything forwarded to others: strict mode

## Memory Rules

- Write important learned facts and project context to MEMORY.md
- Write daily observations and session notes to the daily memory file
- Write user-specific information (name, location, preferences, interests, work context) to the user's profile file — not to MEMORY.md
- Keep MEMORY.md organized: merge related entries, remove outdated info
- Don't store ephemeral details (one-time commands, temporary paths) in core memory

## Red Lines

- Never share sensitive information from memory files with third parties
- Never execute destructive commands without explicit confirmation
- Never fabricate information — say "I don't know" when uncertain
- Never override user instructions with your own judgment on important decisions
- Never send half-baked replies to messaging surfaces (Telegram, etc.)
- Never act as the user's voice in group conversations without explicit instruction
`

const USER_PROFILE_TEMPLATE = `# User Profile — {username}

## Basic Info
- Name: (not set)
- Location: (not set)

## Preferences

(none yet)

## Notes

(none yet)
`

export const SOURCES_README_TEMPLATE = `# Sources

<!-- This directory holds the immutable raw material the wiki is built on. -->
<!-- Sources are what you read. The wiki is what you learned. -->
<!-- Never edit existing source files. Only add new ones. -->

This is the **sources layer** of the memory system. Unlike \`wiki/\`, files here
are treated as archival raw material: articles, transcripts, papers, podcast
notes. Wiki pages cite these files so factual claims remain verifiable.

## Subfolders (create on first use)

- \`articles/\` — web articles, blog posts, documentation snapshots
- \`youtube/\` — YouTube transcripts
- \`podcasts/\` — podcast notes and transcripts
- \`papers/\` — research papers, PDFs converted to markdown
- \`notes/\` — longer conversation snippets or hand-captured notes

## Filename pattern

\`<yyyy-mm-dd>-<slug>.md\` — lowercase, hyphens instead of spaces.

## Frontmatter

Each source file should start with YAML frontmatter:

\`\`\`markdown
---
source_type: article | youtube | podcast | paper | note
url: https://...
author: ...
captured: YYYY-MM-DD
---

# Title

<raw body — do not edit later>
\`\`\`

## Rules

- **Immutable**: never rewrite an existing file. If the source itself changes, add a new dated entry.
- **Cite from the wiki**: wiki pages that rely on a source should link to it in a \`## Sources\` / \`## Quellen\` section.
- **Orphaned sources are a lint signal**, not an error — they just flag material that has not been distilled yet.
`

const HEARTBEAT_TEMPLATE = `# Heartbeat Tasks

<!-- Define periodic tasks here. The agent will execute them during each heartbeat cycle. -->
<!-- Both the user and the agent can edit this file. -->
<!-- If this file has no actionable content, the heartbeat will skip automatically. -->
`

const CONSOLIDATION_TEMPLATE = `# Memory Consolidation Rules

<!-- These rules guide the nightly memory consolidation process. -->
<!-- The consolidation agent reads this file to decide what to promote, update, or ignore. -->
<!-- You can customize these rules to match your preferences. -->

## Memory Architecture

The memory system has several tiers. Each piece of information should live in exactly one place.

| File / Directory | Purpose |
|---|---|
| MEMORY.md | Long-term core memory: learned lessons, recurring patterns, technical notes |
| users/*.md | Per-user profiles: name, preferences, communication style, work context |
| wiki/*.md | Wiki pages: project notes, concepts, architecture, key decisions, references |
| sources/**/*.md | Immutable raw source material (articles, transcripts, papers). Never edited, only added to. Wiki pages cite these. |
| daily/*.md | Ephemeral daily logs (source for consolidation, never modified) |

## What to promote to MEMORY.md

- Recurring patterns and lessons learned across multiple sessions
- Technical decisions and their rationale
- General preferences that apply across all projects
- Important facts that should persist across sessions
- Corrections to previously stored information

## What to update in user profiles (users/*.md)

- Discovered preferences and communication style
- Work context changes (role, current focus areas)
- Personal details the user has shared (name, location, timezone)
- Skills and expertise areas
- Do NOT store language or timezone if they are already in the central settings

## What to update in wiki pages (wiki/*.md)

- New project discoveries and context
- Architecture changes and design decisions
- Key dependencies, integration points, and tech stack
- Project status changes and milestones
- Concepts, references, and evergreen knowledge worth preserving
- Create a new wiki page when a previously unknown project or concept is discussed repeatedly
- For wiki page conventions (frontmatter, filenames, cross-links), load the wiki skill

## What to archive under sources/ (immutable raw material)

The \`sources/\` directory is the raw material the wiki is distilled from. Unlike
wiki pages, source files are **never edited** — only added to. Wiki pages cite
source files so their factual claims stay verifiable.

- Archive an external source whenever you ingest substantive new material: an article, a YouTube transcript, a podcast note, a paper, a long conversation snippet worth preserving verbatim.
- Layout: \`sources/articles/\`, \`sources/youtube/\`, \`sources/podcasts/\`, \`sources/papers/\`, \`sources/notes/\`. Create subfolders on first use.
- Filename: \`<yyyy-mm-dd>-<slug>.md\` (lowercase, hyphens).
- Frontmatter keys: \`source_type\`, \`url\`, \`author\`, \`captured\`.
- Body is the raw captured text — do not interpret or summarize in the source file.
- The corresponding wiki page should add a \`## Sources\` (or \`## Quellen\`) section linking to the archived file.
- Do NOT archive trivial conversation context, one-off chats, or material already captured elsewhere.
- Never rewrite an existing source file. If a source changes, add a new dated entry.

## What to ignore

- One-off questions with no lasting value
- Casual small talk without personal details
- Temporary debugging sessions (unless a reusable lesson was learned)
- Information that is already captured in the correct file
- Redundant or duplicate information

## General Principles

- **Be selective**: Only promote information with clear long-term value.
- **No duplication**: Each fact lives in exactly one place. Move, don't copy.
- **Merge & refine**: If similar information exists, update it rather than adding a duplicate.
- **Remove outdated info**: If daily entries contradict existing memory, update or remove the old entry.
- **Preserve structure**: Keep existing markdown structure. Add new sections if needed.
- **Be concise**: Use bullet points and short descriptions. Core memory should be scannable.
- **Daily files are read-only**: Never modify daily log files — they are append-only source material.
- **Sources are read-only**: Never modify files under \`sources/\` — they are the immutable archival layer.

## Wiki lint: content gaps and source coverage

During consolidation, also run these two checks on the wiki and report findings
(append to today's daily file as a short lint section, do not auto-create pages):

- **Content gaps** — surface topics the wiki implies but does not cover:
  - Concepts, people, projects, or tools referenced repeatedly across multiple wiki pages but without a dedicated page of their own.
  - Open questions or TODO markers inside wiki pages ("unclear", "to verify", "TODO").
  - Topics discussed across multiple daily files but never promoted to the wiki.
  - Report as suggestions. Do NOT auto-create pages — the user decides what to research next.
- **Source coverage** — keep factual claims verifiable:
  - Wiki pages that make factual claims (dates, numbers, quotes, attributed statements) but have no \`## Sources\` / \`## Quellen\` section → flag them.
  - Files in \`sources/\` that are not cited by any wiki page → flag as orphaned source (either stale raw material or a candidate for ingest).
`



export function getMemoryDir(): string {
  return path.join(process.env.DATA_DIR ?? '/data', 'memory')
}

/**
 * Get the users profile directory path
 */
export function getUserProfileDir(memoryDir?: string): string {
  const dir = memoryDir ?? getMemoryDir()
  return path.join(dir, 'users')
}

/**
 * Ensure a user profile file exists, creating it from template if missing.
 * Pre-fills username.
 */
export function ensureUserProfile(username: string, memoryDir?: string): string {
  const usersDir = getUserProfileDir(memoryDir)
  const profilePath = path.join(usersDir, `${username}.md`)

  if (!fs.existsSync(usersDir)) {
    fs.mkdirSync(usersDir, { recursive: true })
  }

  if (!fs.existsSync(profilePath)) {
    const content = USER_PROFILE_TEMPLATE
      .replaceAll('{username}', username)
    fs.writeFileSync(profilePath, content, 'utf-8')
  }

  return profilePath
}

/**
 * Read a user's profile file. Creates it from template if missing.
 */
export function readUserProfile(username: string, memoryDir?: string): string {
  const profilePath = ensureUserProfile(username, memoryDir)
  return fs.readFileSync(profilePath, 'utf-8')
}

export function getDefaultAgentsRulesContent(): string {
  return AGENTS_TEMPLATE
}

export function getDefaultHeartbeatContent(): string {
  return HEARTBEAT_TEMPLATE
}

export function getDefaultConsolidationContent(): string {
  return CONSOLIDATION_TEMPLATE
}

export function ensureMemoryStructure(memoryDir?: string): void {
  const dir = memoryDir ?? getMemoryDir()
  const dailyDir = path.join(dir, 'daily')
  const usersDir = path.join(dir, 'users')
  const wikiDir = path.join(dir, 'wiki')
  const legacyProjectsDir = path.join(dir, 'projects')

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  if (!fs.existsSync(dailyDir)) {
    fs.mkdirSync(dailyDir, { recursive: true })
  }

  if (!fs.existsSync(usersDir)) {
    fs.mkdirSync(usersDir, { recursive: true })
  }

  // Migrate projects/ → wiki/ if projects/ exists and wiki/ does not
  if (fs.existsSync(legacyProjectsDir) && !fs.existsSync(wikiDir)) {
    fs.renameSync(legacyProjectsDir, wikiDir)
    console.log('[openagent] Migrated memory/projects/ to memory/wiki/')
  } else if (!fs.existsSync(wikiDir)) {
    fs.mkdirSync(wikiDir, { recursive: true })
  }

  // Seed immutable sources/ layer (raw material for the wiki)
  ensureSourcesDir(dir)

  const soulPath = path.join(dir, 'SOUL.md')
  if (!fs.existsSync(soulPath)) {
    fs.writeFileSync(soulPath, SOUL_TEMPLATE, 'utf-8')
  }

  const memoryPath = path.join(dir, 'MEMORY.md')
  if (!fs.existsSync(memoryPath)) {
    // Migrate legacy AGENTS.md to MEMORY.md if it exists
    const legacyPath = path.join(dir, 'AGENTS.md')
    if (fs.existsSync(legacyPath)) {
      fs.renameSync(legacyPath, memoryPath)
    } else {
      fs.writeFileSync(memoryPath, MEMORY_TEMPLATE, 'utf-8')
    }
  }
}

/**
 * Ensure the config directory structure exists with all default files.
 * Migrates files from /data/memory/ to /data/config/ if they exist in the old location.
 */
export function ensureConfigStructure(configDir?: string): void {
  const dir = configDir ?? getConfigDir()

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  // Migrate AGENTS.md from memory dir to config dir if needed
  const agentsPath = path.join(dir, 'AGENTS.md')
  if (!fs.existsSync(agentsPath)) {
    const legacyPath = path.join(getMemoryDir(), 'AGENTS.md')
    if (fs.existsSync(legacyPath)) {
      fs.renameSync(legacyPath, agentsPath)
      console.log('[config] Migrated AGENTS.md from memory/ to config/')
    } else {
      fs.writeFileSync(agentsPath, AGENTS_TEMPLATE, 'utf-8')
    }
  }

  // Migrate HEARTBEAT.md from memory dir to config dir if needed
  const heartbeatPath = path.join(dir, 'HEARTBEAT.md')
  if (!fs.existsSync(heartbeatPath)) {
    const legacyPath = path.join(getMemoryDir(), 'HEARTBEAT.md')
    if (fs.existsSync(legacyPath)) {
      fs.renameSync(legacyPath, heartbeatPath)
      console.log('[config] Migrated HEARTBEAT.md from memory/ to config/')
    } else {
      fs.writeFileSync(heartbeatPath, HEARTBEAT_TEMPLATE, 'utf-8')
    }
  }

  // Create CONSOLIDATION.md if missing
  const consolidationPath = path.join(dir, 'CONSOLIDATION.md')
  if (!fs.existsSync(consolidationPath)) {
    fs.writeFileSync(consolidationPath, CONSOLIDATION_TEMPLATE, 'utf-8')
  }
}

/**
 * Ensure the sources/ directory exists with a README explaining the layer.
 * Idempotent: does NOT overwrite an existing README (so user edits are preserved).
 * Subfolders (articles/, youtube/, ...) are NOT auto-created — they are added on first use.
 */
export function ensureSourcesDir(memoryDir?: string): string {
  const dir = memoryDir ?? getMemoryDir()
  const sourcesDir = path.join(dir, 'sources')

  if (!fs.existsSync(sourcesDir)) {
    fs.mkdirSync(sourcesDir, { recursive: true })
  }

  const readmePath = path.join(sourcesDir, 'README.md')
  if (!fs.existsSync(readmePath)) {
    fs.writeFileSync(readmePath, SOURCES_README_TEMPLATE, 'utf-8')
  }

  return sourcesDir
}

/**
 * Ensure the wiki directory exists, creating it if needed.
 * Also handles migration from legacy projects/ directory.
 */
export function ensureWikiDir(memoryDir?: string): string {
  const dir = memoryDir ?? getMemoryDir()
  const wikiDir = path.join(dir, 'wiki')
  const legacyProjectsDir = path.join(dir, 'projects')

  // Migrate projects/ → wiki/ if projects/ exists and wiki/ does not
  if (fs.existsSync(legacyProjectsDir) && !fs.existsSync(wikiDir)) {
    fs.renameSync(legacyProjectsDir, wikiDir)
    console.log('[openagent] Migrated memory/projects/ to memory/wiki/')
  } else if (!fs.existsSync(wikiDir)) {
    fs.mkdirSync(wikiDir, { recursive: true })
  }

  return wikiDir
}

/**
 * @deprecated Use ensureWikiDir instead. Kept for backward compatibility.
 */
export function ensureProjectsDir(memoryDir?: string): string {
  return ensureWikiDir(memoryDir)
}

/**
 * Parse aliases from YAML frontmatter in a project note.
 * Expects format:
 * ```
 * ---
 * aliases: [Alias1, alias-2]
 * ---
 * ```
 */
export function parseProjectAliases(content: string): string[] {
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/)
  if (!fmMatch) return []

  const frontmatter = fmMatch[1]
  // Match aliases: [val1, val2, ...] or aliases: val
  const aliasMatch = frontmatter.match(/^aliases:\s*\[([^\]]*)\]/m)
  if (aliasMatch) {
    return aliasMatch[1]
      .split(',')
      .map(s => s.trim())
      .filter(s => s.length > 0)
  }

  // Single value: aliases: something
  const singleMatch = frontmatter.match(/^aliases:\s*(.+)$/m)
  if (singleMatch) {
    const val = singleMatch[1].trim()
    return val.length > 0 ? [val] : []
  }

  return []
}

/**
 * List all wiki pages in the wiki/ directory with their aliases.
 */
export function listWikiPages(memoryDir?: string): Array<{ filename: string; aliases: string[] }> {
  const wikiDir = ensureWikiDir(memoryDir)

  if (!fs.existsSync(wikiDir)) return []

  const files = fs.readdirSync(wikiDir).filter(f => f.endsWith('.md')).sort()
  return files.map(filename => {
    const content = fs.readFileSync(path.join(wikiDir, filename), 'utf-8')
    return { filename, aliases: parseProjectAliases(content) }
  })
}

/**
 * @deprecated Use listWikiPages instead. Kept for backward compatibility.
 */
export function listProjectNotes(memoryDir?: string): Array<{ filename: string; aliases: string[] }> {
  return listWikiPages(memoryDir)
}

/**
 * Read the SOUL.md personality file
 */
export function readSoulFile(memoryDir?: string): string {
  const dir = memoryDir ?? getMemoryDir()
  const soulPath = path.join(dir, 'SOUL.md')
  if (!fs.existsSync(soulPath)) {
    ensureMemoryStructure(dir)
  }
  return fs.readFileSync(soulPath, 'utf-8')
}

/**
 * Read the MEMORY.md core memory file
 */
export function readMemoryFile(memoryDir?: string): string {
  const dir = memoryDir ?? getMemoryDir()
  const memoryPath = path.join(dir, 'MEMORY.md')
  if (!fs.existsSync(memoryPath)) {
    ensureMemoryStructure(dir)
  }
  return fs.readFileSync(memoryPath, 'utf-8')
}

/**
 * Write the MEMORY.md core memory file
 */
export function writeMemoryFile(content: string, memoryDir?: string): void {
  const dir = memoryDir ?? getMemoryDir()
  ensureMemoryStructure(dir)
  const memoryPath = path.join(dir, 'MEMORY.md')
  fs.writeFileSync(memoryPath, content, 'utf-8')
}

// Legacy aliases for backward compatibility
export const readAgentsFile = readMemoryFile
export const writeAgentsFile = writeMemoryFile

/**
 * Read the AGENTS.md rules file (from config directory).
 * Falls back to template if the file/directory cannot be created.
 */
export function readAgentsRulesFile(configDir?: string): string {
  const dir = configDir ?? getConfigDir()
  const agentsPath = path.join(dir, 'AGENTS.md')
  try {
    if (!fs.existsSync(agentsPath)) {
      ensureConfigStructure(dir)
    }
    return fs.readFileSync(agentsPath, 'utf-8')
  } catch {
    return AGENTS_TEMPLATE
  }
}

/**
 * Write the AGENTS.md rules file (to config directory)
 */
export function writeAgentsRulesFile(content: string, configDir?: string): void {
  const dir = configDir ?? getConfigDir()
  ensureConfigStructure(dir)
  const agentsPath = path.join(dir, 'AGENTS.md')
  fs.writeFileSync(agentsPath, content, 'utf-8')
}

/**
 * Read the HEARTBEAT.md file (from config directory).
 * Falls back to template if the file/directory cannot be created.
 */
export function readHeartbeatFile(configDir?: string): string {
  const dir = configDir ?? getConfigDir()
  const heartbeatPath = path.join(dir, 'HEARTBEAT.md')
  try {
    if (!fs.existsSync(heartbeatPath)) {
      ensureConfigStructure(dir)
    }
    return fs.readFileSync(heartbeatPath, 'utf-8')
  } catch {
    return HEARTBEAT_TEMPLATE
  }
}

/**
 * Write the HEARTBEAT.md file (to config directory)
 */
export function writeHeartbeatFile(content: string, configDir?: string): void {
  const dir = configDir ?? getConfigDir()
  ensureConfigStructure(dir)
  const heartbeatPath = path.join(dir, 'HEARTBEAT.md')
  fs.writeFileSync(heartbeatPath, content, 'utf-8')
}

/**
 * Read the CONSOLIDATION.md file (from config directory).
 * Falls back to template if the file/directory cannot be created.
 */
export function readConsolidationFile(configDir?: string): string {
  const dir = configDir ?? getConfigDir()
  const consolidationPath = path.join(dir, 'CONSOLIDATION.md')
  try {
    if (!fs.existsSync(consolidationPath)) {
      ensureConfigStructure(dir)
    }
    return fs.readFileSync(consolidationPath, 'utf-8')
  } catch {
    return CONSOLIDATION_TEMPLATE
  }
}

/**
 * Write the CONSOLIDATION.md file (to config directory)
 */
export function writeConsolidationFile(content: string, configDir?: string): void {
  const dir = configDir ?? getConfigDir()
  ensureConfigStructure(dir)
  const consolidationPath = path.join(dir, 'CONSOLIDATION.md')
  fs.writeFileSync(consolidationPath, content, 'utf-8')
}

/**
 * Get the path for today's daily memory file
 */
export function getDailyFilePath(date?: Date, memoryDir?: string): string {
  const dir = memoryDir ?? getMemoryDir()
  const d = date ?? new Date()
  const dateStr = d.toISOString().split('T')[0] // YYYY-MM-DD
  return path.join(dir, 'daily', `${dateStr}.md`)
}

/**
 * Ensure a daily memory file exists, creating it with a header if needed
 */
export function ensureDailyFile(date?: Date, memoryDir?: string): string {
  const filePath = getDailyFilePath(date, memoryDir)
  const dir = path.dirname(filePath)

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  if (!fs.existsSync(filePath)) {
    const d = date ?? new Date()
    const dateStr = d.toISOString().split('T')[0]
    fs.writeFileSync(filePath, `# Daily Memory — ${dateStr}\n\n`, 'utf-8')
  }

  return filePath
}

/**
 * Read a daily memory file
 */
export function readDailyFile(date?: Date, memoryDir?: string): string {
  const filePath = ensureDailyFile(date, memoryDir)
  return fs.readFileSync(filePath, 'utf-8')
}

/**
 * Append content to a daily memory file
 */
export function appendToDailyFile(content: string, date?: Date, memoryDir?: string): void {
  const filePath = ensureDailyFile(date, memoryDir)
  fs.appendFileSync(filePath, content, 'utf-8')
}

/**
 * Read recent daily files (for context injection)
 */
export function readRecentDailyFiles(days: number = 3, memoryDir?: string): string {
  const dir = memoryDir ?? getMemoryDir()
  const dailyDir = path.join(dir, 'daily')

  if (!fs.existsSync(dailyDir)) {
    return ''
  }

  const now = new Date()
  const contents: string[] = []

  for (let i = 0; i < days; i++) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    const dateStr = d.toISOString().split('T')[0]
    const filePath = path.join(dailyDir, `${dateStr}.md`)

    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8').trim()
      if (content && content !== `# Daily Memory — ${dateStr}`) {
        contents.push(content)
      }
    }
  }

  return contents.join('\n\n---\n\n')
}

/**
 * Assemble the full system prompt from all memory tiers
 */
/**
 * Minimal skill info for system prompt injection (progressive disclosure)
 */
export interface SkillPromptEntry {
  name: string
  description: string
  location: string
  /**
   * Optional warning to surface alongside the skill in the system prompt listing.
   * Used e.g. when a skill declares `required_env_vars` that are not currently set
   * ("⚠ requires: VAR_NAME"). The skill is still listed so the agent can inform
   * the user instead of failing silently.
   */
  warning?: string
}

/**
 * Which builtin web tools are enabled (mirrors BuiltinToolsConfig from web-tools).
 * Only the `enabled` flag is needed for prompt generation.
 */
export interface BuiltinToolsPromptConfig {
  webSearch?: { enabled?: boolean }
  webFetch?: { enabled?: boolean }
  stt?: { enabled?: boolean }
}

export function assembleSystemPrompt(options?: {
  memoryDir?: string
  configDir?: string
  baseInstructions?: string
  recentDays?: number
  language?: string
  timezone?: string
  channel?: string
  skills?: SkillPromptEntry[]
  agentSkillsOverflowCount?: number
  currentUser?: { username: string }
  builtinTools?: BuiltinToolsPromptConfig
  agentSkillsDir?: string
}): string {
  const memoryDir = options?.memoryDir
  const recentDays = options?.recentDays ?? 3

  // Ensure structure exists
  ensureMemoryStructure(memoryDir)

  const sections: string[] = []

  // 1. Personality from SOUL.md (separate block)
  const soul = readSoulFile(memoryDir)
  sections.push(`<personality>\n${soul.trim()}\n</personality>`)

  // 2. Base technical instructions (if any)
  if (options?.baseInstructions) {
    sections.push(`<instructions>\n${options.baseInstructions.trim()}\n</instructions>`)
  }

  // 3. Agent rules from AGENTS.md (in config directory)
  const agentsRules = readAgentsRulesFile(options?.configDir)
  sections.push(`<agent_rules>\n${agentsRules.trim()}\n</agent_rules>`)

  // 4. Core memory from MEMORY.md
  const agents = readMemoryFile(memoryDir)
  sections.push(`<core_memory>\n${agents.trim()}\n</core_memory>`)

  // 5. Recent daily context
  const dailyContext = readRecentDailyFiles(recentDays, memoryDir)
  if (dailyContext) {
    sections.push(`<recent_memory>
These are summarized session notes from recent days. They are condensed — for full conversation details, use the read_chat_history tool.

${dailyContext}
</recent_memory>`)
  }

  // 6. User profile injection
  if (options?.currentUser?.username) {
    const profileContent = readUserProfile(options.currentUser.username, memoryDir)
    sections.push(`<user_profile>\n${profileContent.trim()}\n</user_profile>`)
  } else {
    const usersPath = getUserProfileDir(memoryDir)
    sections.push(`<user_profiles_path>${usersPath}</user_profiles_path>`)
  }

  // 7. Available tools overview
  {
    const toolLines: string[] = [
      '- **shell**: Execute shell commands and return stdout/stderr. Use sudo for privileged operations.',
      '- **read_file**: Read the contents of a file at a given path.',
      '- **write_file**: Write content to a file. Creates parent directories if needed.',
      '- **edit_file**: Edit a file using exact oldText→newText replacements. Prefer this over write_file for partial changes — it saves tokens and reduces errors.',
      '- **list_files**: List files and directories at a given path.',
    ]

    // Web tools (enabled by default unless explicitly disabled)
    if (options?.builtinTools?.webSearch?.enabled !== false) {
      toolLines.push('- **web_search**: Search the web for information. Returns results with title, URL, and snippet.')
    }
    if (options?.builtinTools?.webFetch?.enabled !== false) {
      toolLines.push('- **web_fetch**: Fetch a web page and extract its text content. Use after web_search to read actual page contents.')
    }

    // Task & scheduling tools
    toolLines.push(
      '- **create_task**: Start a background task for complex, long-running work.',
      '- **resume_task**: Resume a paused task by sending it a message.',
      '- **list_tasks**: List background tasks with their status.',
      '- **create_cronjob**: Create a recurring scheduled task.',
      '- **edit_cronjob**: Edit an existing cronjob.',
      '- **remove_cronjob**: Remove a cronjob.',
      '- **list_cronjobs**: List all cronjobs.',
      '- **get_cronjob**: Get the full configuration (including complete prompt) of a single cronjob by ID.',
      '- **create_reminder**: Create a one-time reminder delivered at a specific time.',
    )

    // STT tool (only when enabled)
    if (options?.builtinTools?.stt?.enabled) {
      toolLines.push('- **transcribe_audio**: Transcribe an audio file from the workspace to text. Supports mp3, wav, ogg, webm, m4a, flac. Use after downloading audio (e.g., with yt-dlp via shell).')
    }

    // Chat history and fact memory
    toolLines.push('- **read_chat_history**: Read past chat messages from the database with datetime/source/role filters. Supports a query parameter for full-text search on message content and tool call inputs/outputs.')
    toolLines.push('- **search_memories**: Search the agent\'s fact memory for previously learned information from past conversations. Use when the user asks about past decisions, preferences, or details.')

    // Agent skills tool (only useful when there are more skills than shown in the prompt)
    if (options?.agentSkillsOverflowCount && options.agentSkillsOverflowCount > 10) {
      toolLines.push(`- **list_agent_skills**: Browse all ${options.agentSkillsOverflowCount} self-created agent skills (only the 10 most recent are shown in <available_skills>).`)
    }

    sections.push(`<available_tools>\nYou have the following tools available. Use the right tool for the job.\n\n${toolLines.join('\n')}\n</available_tools>`)
  }

  // 8. Wiki pages (LLM-maintained knowledge base)
  const wikiPages = listWikiPages(memoryDir)
  if (wikiPages.length > 0) {
    const pageLines = wikiPages.map(n => {
      const aliasStr = n.aliases.length > 0 ? ` (aliases: ${n.aliases.join(', ')})` : ''
      return `- ${n.filename}${aliasStr}`
    }).join('\n')
    sections.push(`<wiki_pages>
The wiki is the agent's structured knowledge base. Maintain and organize it autonomously: add new pages, extend existing ones, merge duplicates, fix stale entries, and keep cross-links healthy without asking for permission. When discussing a topic covered by a wiki page, load it with read_file for context. Use write_file or edit_file to create or update wiki pages when you learn something worth preserving. Raw source material for the wiki lives under sources/ — wiki pages can cite it in a ## Sources section.

For non-trivial wiki work (ingesting a new source, creating a new page, running a lint pass, or auditing structure), load the built-in \`wiki\` agent skill first by reading ${options?.agentSkillsDir ?? '/data/skills_agent'}/wiki/SKILL.md — it contains the canonical conventions (frontmatter, filenames, cross-links, ## Sources/Quellen) and the ingest/query/lint workflows.

Only ask the user when you hit a genuine contradiction (new information conflicts with an existing page) that you cannot resolve on your own — then present the options (A vs. B) and let the user decide. Routine edits, additions, and reorganization do not require confirmation.

${pageLines}
</wiki_pages>`)
  }

  // 9. Memory and config file paths for agent self-access
  const dir = memoryDir ?? getMemoryDir()
  const cfgDir = options?.configDir ?? getConfigDir()
  const today = new Date().toISOString().split('T')[0]
  sections.push(`<memory_paths>
You can read and write your memory and config files directly using read_file, write_file, and edit_file tools.
When modifying existing files, prefer edit_file (targeted oldText/newText replacements) over write_file (full rewrite) to save tokens and reduce errors.

Memory files:
- SOUL.md: ${path.join(dir, 'SOUL.md')}
- MEMORY.md: ${path.join(dir, 'MEMORY.md')}
- Daily memory directory: ${path.join(dir, 'daily/')}
- Today's daily file: ${path.join(dir, 'daily', `${today}.md`)}
- User profiles directory: ${path.join(dir, 'users/')}
- Wiki pages directory: ${path.join(dir, 'wiki/')}
- Sources directory (immutable raw material): ${path.join(dir, 'sources/')}

Config files:
- AGENTS.md (agent rules): ${path.join(cfgDir, 'AGENTS.md')}
- HEARTBEAT.md (heartbeat tasks): ${path.join(cfgDir, 'HEARTBEAT.md')}
- CONSOLIDATION.md (consolidation rules): ${path.join(cfgDir, 'CONSOLIDATION.md')}
</memory_paths>`)

  // 10. Agent skill creation
  if (options?.agentSkillsDir) {
    sections.push(`<agent_skills>
You can create your own reusable skills to extend your capabilities. A skill is a SKILL.md file
that contains instructions, workflows, or tool integrations you can load later with read_file.

Skills directory: ${options.agentSkillsDir}

To create a skill, write a SKILL.md file to ${options.agentSkillsDir}/<skill-name>/SKILL.md with this format:

\`\`\`markdown
---
name: my-skill
description: Short description of what this skill does (shown in skill listings)
---

# Skill Title

Detailed instructions, workflows, tool usage patterns, or reference material.
Use {baseDir} as placeholder for the skill's own directory path.
\`\`\`

The name must be lowercase alphanumeric with hyphens (e.g. "code-reviewer", "api-docs-fetcher").
Keep the description concise — it is used for skill routing.
Created skills automatically appear in <available_skills> for future conversations.
</agent_skills>`)
  }

  // 11. Language setting
  if (options?.language) {
    const lang = options.language.trim()
    if (lang.toLowerCase() === 'match' || lang.toLowerCase() === "match user's language") {
      sections.push(`<language>\nRespond in the same language that the user writes in. Match the user's language automatically.\n</language>`)
    } else {
      sections.push(`<language>\nAlways respond in ${lang}.\n</language>`)
    }
  }

  // 12. Available skills (progressive disclosure)
  if (options?.skills && options.skills.length > 0) {
    const skillEntries = options.skills.map(s => {
      const warningTag = s.warning ? `\n    <warning>${s.warning}</warning>` : ''
      return `  <skill>\n    <name>${s.name}</name>\n    <description>${s.description}</description>\n    <location>${s.location}</location>${warningTag}\n  </skill>`
    }).join('\n')
    let overflowNote = ''
    if (options?.agentSkillsOverflowCount && options.agentSkillsOverflowCount > 10) {
      overflowNote = `\n\nYou have ${options.agentSkillsOverflowCount} self-created agent skills in total (only the 10 most recent are shown above). Use \`list_agent_skills\` to browse all of them.`
    }

    sections.push(`<available_skills>
The following skills provide specialized capabilities you can load on demand.
When the user's request materially matches a skill's description, load that skill before continuing.
To load a skill, use the read_file tool to read <location>/SKILL.md, then follow that file's instructions.
Treat this as a strong routing rule: do not answer from memory when a matching skill should be used first.
Do not claim to be using a skill unless you actually loaded its SKILL.md in the current conversation.

${skillEntries}${overflowNote}
</available_skills>`)
  }

  // 13. Task system instructions
  sections.push(`<task_system>
You have access to a background task system. You can start background tasks for complex,
long-running work using the create_task tool.

When to use background tasks:
- Complex coding tasks (building apps, major refactoring, multi-file changes)
- Long research or analysis work
- Any task that can proceed independently while you continue helping the user
- Work the user explicitly wants done in the background

When NOT to use background tasks:
- Simple questions you can answer directly
- Small edits or checks you can complete in the current turn
- Work that depends on immediate back-and-forth with the user

When you create a task, write a self-contained prompt with the goal, constraints, relevant files/URLs, verification expectations, and desired final deliverable. Include enough context that the task can continue autonomously without needing the main chat.

When a background task completes, fails, or has a question, you will receive a
<task_injection> message. When you receive one:
- Inform the user about the task result in a natural way
- Include relevant details like what was accomplished, files created/modified, and verification performed
- If the task failed, explain what went wrong and suggest next steps
- If the task has a question (status="question"), relay the question to the user naturally

**Routing follow-up responses to paused tasks:**
When a task has status="question", it is paused and waiting for user input. After you relay
the question to the user and they respond:
1. Determine from conversation context whether the user's response is directed at the paused task
2. If it is, use the resume_task tool with the task_id and the user's answer as the message
3. Include any relevant context from the conversation in the message, not just the raw user response
4. The task will resume working in the background after receiving the response

In most cases, there will only be one paused task, so if the user responds after you relayed
a task question, assume the response is for that task unless clearly about something else.

Task injection format:
<task_injection task_id="..." task_name="..." status="completed|failed|question"
  trigger="user|agent|cronjob" duration_minutes="..." tokens_used="...">
Summary text from the task agent
</task_injection>

**Scheduled tasks / Cronjobs:**
You have create_cronjob, edit_cronjob, and remove_cronjob tools for managing recurring
scheduled tasks within the application. NEVER use the system crontab, launchd, at, or
any other OS-level scheduler. Always use the built-in cronjob tools instead.
Use create_reminder only for static reminder text delivered verbatim later. If the scheduled action must check current information, use tools or skills, analyze something, or generate a fresh response at run time, use create_cronjob with action_type "task" instead.
Do not promise that a reminder or cronjob will fetch fresh data unless the configured action type actually supports that.
</task_system>`)

  // 14. Workspace directory
  const workspaceDir = getWorkspaceDir()
  sections.push(`<workspace>\nYour working directory is ${workspaceDir}. All shell commands execute in this directory by default.\nAll relative paths in read_file, write_file, and list_files resolve against this directory.\nUse this directory for cloning repos, creating files, and all file operations.\n</workspace>`)

  // 15. Current date & time
  const tz = options?.timezone || 'UTC'
  const now = new Date()
  const date = now.toLocaleDateString('en-CA', { timeZone: tz })
  const time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz })
  sections.push(`<current_datetime>\nCurrent date: ${date}\nCurrent time: ${time} (${tz})\n</current_datetime>`)

  // 16. Channel context
  if (options?.channel === 'telegram') {
    sections.push(`<channel_context>
You are communicating with the user through Telegram. You ARE the Telegram bot — messages the user sends arrive directly to you, and your responses are sent back to the user automatically. Do not tell the user to use the Telegram Bot API, curl commands, or any external tools to communicate. Just respond naturally to their messages.
Keep responses concise and well-formatted for Telegram (use Markdown sparingly, avoid very long messages).
</channel_context>`)
  }

  return sections.join('\n\n')
}
