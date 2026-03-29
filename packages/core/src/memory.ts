import fs from 'node:fs'
import path from 'node:path'

const SOUL_TEMPLATE = `# Soul

You are openagent, a helpful AI assistant.

## Personality
- Friendly and professional
- Concise but thorough
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

export function getMemoryDir(): string {
  return path.join(process.env.DATA_DIR ?? '/data', 'memory')
}

export function ensureMemoryStructure(memoryDir?: string): void {
  const dir = memoryDir ?? getMemoryDir()
  const dailyDir = path.join(dir, 'daily')

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  if (!fs.existsSync(dailyDir)) {
    fs.mkdirSync(dailyDir, { recursive: true })
  }

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

  // 3. Core memory from MEMORY.md
  const agents = readMemoryFile(memoryDir)
  sections.push(`<core_memory>\n${agents.trim()}\n</core_memory>`)

  // 4. Recent daily context
  const dailyContext = readRecentDailyFiles(recentDays, memoryDir)
  if (dailyContext) {
    sections.push(`<recent_memory>\n${dailyContext}\n</recent_memory>`)
  }

  // 5. Language setting
  if (options?.language) {
    const lang = options.language.trim()
    if (lang.toLowerCase() === 'match' || lang.toLowerCase() === "match user's language") {
      sections.push(`<language>\nRespond in the same language that the user writes in. Match the user's language automatically.\n</language>`)
    } else {
      sections.push(`<language>\nAlways respond in ${lang}.\n</language>`)
    }
  }

  // 6. Available skills (progressive disclosure)
  if (options?.skills && options.skills.length > 0) {
    const skillEntries = options.skills.map(s =>
      `  <skill>\n    <name>${s.name}</name>\n    <description>${s.description}</description>\n    <location>${s.location}</location>\n  </skill>`
    ).join('\n')
    sections.push(`<available_skills>
The following skills provide specialized capabilities you can load on demand.
When a user's request matches a skill's description, use the read_file tool to read <location>/SKILL.md to load the full instructions.

${skillEntries}
</available_skills>`)
  }

  // 7. Current date & time
  const tz = options?.timezone || 'UTC'
  const now = new Date()
  const date = now.toLocaleDateString('en-CA', { timeZone: tz })
  const time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz })
  sections.push(`<current_datetime>\nCurrent date: ${date}\nCurrent time: ${time} (${tz})\n</current_datetime>`)

  // 8. Channel context
  if (options?.channel === 'telegram') {
    sections.push(`<channel_context>
You are communicating with the user through Telegram. You ARE the Telegram bot — messages the user sends arrive directly to you, and your responses are sent back to the user automatically. Do not tell the user to use the Telegram Bot API, curl commands, or any external tools to communicate. Just respond naturally to their messages.
Keep responses concise and well-formatted for Telegram (use Markdown sparingly, avoid very long messages).
</channel_context>`)
  }

  return sections.join('\n\n')
}
