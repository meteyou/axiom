import fs from 'node:fs'
import path from 'node:path'
import { getWorkspaceDir } from './workspace.js'

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

## Execution Rules

- Ask before making destructive changes (deleting files, dropping data, overwriting important config)
- When making code changes, explain the reasoning briefly
- Prefer small, verifiable changes over large rewrites
- If a task is ambiguous, ask one clarifying question rather than guessing
- When multiple approaches exist, state the tradeoff and recommend one

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

const HEARTBEAT_TEMPLATE = `# Heartbeat Tasks

This file defines periodic tasks the agent runs during heartbeat cycles.
Both the user and the agent can edit this file.
Be efficient — if nothing needs attention, complete silently.

## Daily Memory Update

- Use the read_chat_history tool to read recent chat messages (filter by start datetime to only get messages since last heartbeat)
- Extract important facts, decisions, preferences, and context that aren't yet captured
- Write new observations to today's daily memory file (/data/memory/daily/YYYY-MM-DD.md)
- Focus on: user preferences learned, project decisions made, technical facts discovered, open action items
- Skip ephemeral chatter — only persist information with lasting value
- Don't duplicate what session summaries already captured

## Memory Hygiene

- Check MEMORY.md for outdated or contradictory entries
- If daily memory has important insights not yet in MEMORY.md, promote them
- Keep MEMORY.md well-organized and scannable
- Skip if nothing meaningful changed since last heartbeat

## Open Tasks

(Add periodic checks, reminders, or monitoring tasks here)
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

export function ensureMemoryStructure(memoryDir?: string): void {
  const dir = memoryDir ?? getMemoryDir()
  const dailyDir = path.join(dir, 'daily')
  const usersDir = path.join(dir, 'users')

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  if (!fs.existsSync(dailyDir)) {
    fs.mkdirSync(dailyDir, { recursive: true })
  }

  if (!fs.existsSync(usersDir)) {
    fs.mkdirSync(usersDir, { recursive: true })
  }

  const soulPath = path.join(dir, 'SOUL.md')
  if (!fs.existsSync(soulPath)) {
    fs.writeFileSync(soulPath, SOUL_TEMPLATE, 'utf-8')
  }

  const memoryPath = path.join(dir, 'MEMORY.md')
  if (!fs.existsSync(memoryPath)) {
    // Migrate legacy AGENTS.md to MEMORY.md if it exists
    // (only if new AGENTS.md doesn't exist yet — avoid conflict)
    const legacyPath = path.join(dir, 'AGENTS.md')
    if (fs.existsSync(legacyPath)) {
      fs.renameSync(legacyPath, memoryPath)
    } else {
      fs.writeFileSync(memoryPath, MEMORY_TEMPLATE, 'utf-8')
    }
  }

  const agentsPath = path.join(dir, 'AGENTS.md')
  if (!fs.existsSync(agentsPath)) {
    fs.writeFileSync(agentsPath, AGENTS_TEMPLATE, 'utf-8')
  }

  const heartbeatPath = path.join(dir, 'HEARTBEAT.md')
  if (!fs.existsSync(heartbeatPath)) {
    fs.writeFileSync(heartbeatPath, HEARTBEAT_TEMPLATE, 'utf-8')
  }
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
 * Read the AGENTS.md rules file
 */
export function readAgentsRulesFile(memoryDir?: string): string {
  const dir = memoryDir ?? getMemoryDir()
  const agentsPath = path.join(dir, 'AGENTS.md')
  if (!fs.existsSync(agentsPath)) {
    ensureMemoryStructure(dir)
  }
  return fs.readFileSync(agentsPath, 'utf-8')
}

/**
 * Write the AGENTS.md rules file
 */
export function writeAgentsRulesFile(content: string, memoryDir?: string): void {
  const dir = memoryDir ?? getMemoryDir()
  ensureMemoryStructure(dir)
  const agentsPath = path.join(dir, 'AGENTS.md')
  fs.writeFileSync(agentsPath, content, 'utf-8')
}

/**
 * Read the HEARTBEAT.md file
 */
export function readHeartbeatFile(memoryDir?: string): string {
  const dir = memoryDir ?? getMemoryDir()
  const heartbeatPath = path.join(dir, 'HEARTBEAT.md')
  if (!fs.existsSync(heartbeatPath)) {
    ensureMemoryStructure(dir)
  }
  return fs.readFileSync(heartbeatPath, 'utf-8')
}

/**
 * Write the HEARTBEAT.md file
 */
export function writeHeartbeatFile(content: string, memoryDir?: string): void {
  const dir = memoryDir ?? getMemoryDir()
  ensureMemoryStructure(dir)
  const heartbeatPath = path.join(dir, 'HEARTBEAT.md')
  fs.writeFileSync(heartbeatPath, content, 'utf-8')
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
}

export function assembleSystemPrompt(options?: {
  memoryDir?: string
  baseInstructions?: string
  recentDays?: number
  language?: string
  timezone?: string
  channel?: string
  skills?: SkillPromptEntry[]
  agentSkillsOverflowCount?: number
  currentUser?: { username: string }
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

  // 3. Agent rules from AGENTS.md
  const agentsRules = readAgentsRulesFile(memoryDir)
  sections.push(`<agent_rules>\n${agentsRules.trim()}\n</agent_rules>`)

  // 4. Core memory from MEMORY.md
  const agents = readMemoryFile(memoryDir)
  sections.push(`<core_memory>\n${agents.trim()}\n</core_memory>`)

  // 5. Recent daily context
  const dailyContext = readRecentDailyFiles(recentDays, memoryDir)
  if (dailyContext) {
    sections.push(`<recent_memory>\n${dailyContext}\n</recent_memory>`)
  }

  // 6. User profile injection
  if (options?.currentUser?.username) {
    const profileContent = readUserProfile(options.currentUser.username, memoryDir)
    sections.push(`<user_profile>\n${profileContent.trim()}\n</user_profile>`)
  } else {
    const usersPath = getUserProfileDir(memoryDir)
    sections.push(`<user_profiles_path>${usersPath}</user_profiles_path>`)
  }

  // 7. Memory file paths for agent self-access
  const dir = memoryDir ?? getMemoryDir()
  const today = new Date().toISOString().split('T')[0]
  sections.push(`<memory_paths>
You can read and write your memory files directly using read_file, write_file, and edit_file tools.
When modifying existing files, prefer edit_file (targeted oldText/newText replacements) over write_file (full rewrite) to save tokens and reduce errors.
- SOUL.md: ${path.join(dir, 'SOUL.md')}
- MEMORY.md: ${path.join(dir, 'MEMORY.md')}
- AGENTS.md: ${path.join(dir, 'AGENTS.md')}
- HEARTBEAT.md: ${path.join(dir, 'HEARTBEAT.md')}
- Daily memory directory: ${path.join(dir, 'daily/')}
- Today's daily file: ${path.join(dir, 'daily', `${today}.md`)}
- User profiles directory: ${path.join(dir, 'users/')}
</memory_paths>`)

  // 8. Language setting
  if (options?.language) {
    const lang = options.language.trim()
    if (lang.toLowerCase() === 'match' || lang.toLowerCase() === "match user's language") {
      sections.push(`<language>\nRespond in the same language that the user writes in. Match the user's language automatically.\n</language>`)
    } else {
      sections.push(`<language>\nAlways respond in ${lang}.\n</language>`)
    }
  }

  // 9. Available skills (progressive disclosure)
  if (options?.skills && options.skills.length > 0) {
    const skillEntries = options.skills.map(s =>
      `  <skill>\n    <name>${s.name}</name>\n    <description>${s.description}</description>\n    <location>${s.location}</location>\n  </skill>`
    ).join('\n')
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

  // 10. Task system instructions
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

  // 11. Workspace directory
  const workspaceDir = getWorkspaceDir()
  sections.push(`<workspace>\nYour working directory is ${workspaceDir}. All shell commands execute in this directory by default.\nAll relative paths in read_file, write_file, and list_files resolve against this directory.\nUse this directory for cloning repos, creating files, and all file operations.\n</workspace>`)

  // 12. Current date & time
  const tz = options?.timezone || 'UTC'
  const now = new Date()
  const date = now.toLocaleDateString('en-CA', { timeZone: tz })
  const time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz })
  sections.push(`<current_datetime>\nCurrent date: ${date}\nCurrent time: ${time} (${tz})\n</current_datetime>`)

  // 13. Channel context
  if (options?.channel === 'telegram') {
    sections.push(`<channel_context>
You are communicating with the user through Telegram. You ARE the Telegram bot — messages the user sends arrive directly to you, and your responses are sent back to the user automatically. Do not tell the user to use the Telegram Bot API, curl commands, or any external tools to communicate. Just respond naturally to their messages.
Keep responses concise and well-formatted for Telegram (use Markdown sparingly, avoid very long messages).
</channel_context>`)
  }

  return sections.join('\n\n')
}
