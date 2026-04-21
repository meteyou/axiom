import fs from 'node:fs'
import path from 'node:path'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import { Type } from '@mariozechner/pi-ai'
import { parseSkillMd } from './skill-parser.js'
import type { SkillPromptEntry } from './memory.js'

/**
 * Usage tracking entry: skill name → last used ISO timestamp
 */
export interface AgentSkillUsage {
  [skillName: string]: string // ISO timestamp
}

/**
 * Agent skill entry returned by listing functions
 */
export interface AgentSkillEntry {
  name: string
  description: string
  location: string
  lastUsed?: string // ISO timestamp
}

const USAGE_FILENAME = '.usage.json'

/**
 * Get the agent skills directory path.
 * Uses DATA_DIR env var, falling back to /data.
 */
export function getAgentSkillsDir(): string {
  const dataDir = process.env.DATA_DIR ?? '/data'
  return path.join(dataDir, 'skills_agent')
}

/**
 * Ensure the agent skills directory exists, creating it if missing.
 * Returns the directory path, or null if it cannot be created.
 */
function ensureAgentSkillsDir(): string | null {
  const dir = getAgentSkillsDir()
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    return dir
  } catch {
    return null
  }
}

/**
 * Read the usage tracking JSON file.
 * Returns empty object if file doesn't exist or is invalid.
 */
function readUsageFile(): AgentSkillUsage {
  const dir = getAgentSkillsDir()
  const usagePath = path.join(dir, USAGE_FILENAME)
  try {
    if (fs.existsSync(usagePath)) {
      const content = fs.readFileSync(usagePath, 'utf-8')
      const parsed = JSON.parse(content)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as AgentSkillUsage
      }
    }
  } catch {
    // Corrupted file, return empty
  }
  return {}
}

/**
 * Write the usage tracking JSON file.
 */
function writeUsageFile(usage: AgentSkillUsage): void {
  const dir = ensureAgentSkillsDir()
  if (!dir) return
  const usagePath = path.join(dir, USAGE_FILENAME)
  // Atomic write: write to temp file then rename for concurrent access safety
  const tmpPath = usagePath + '.tmp'
  fs.writeFileSync(tmpPath, JSON.stringify(usage, null, 2) + '\n', 'utf-8')
  fs.renameSync(tmpPath, usagePath)
}

/**
 * List all agent-managed skills by scanning the skills_agent directory.
 * Creates the directory if it doesn't exist.
 * Returns entries with name, description, location, and optional lastUsed timestamp.
 */
export function listAgentSkills(): AgentSkillEntry[] {
  const dir = ensureAgentSkillsDir()
  if (!dir) return []
  const usage = readUsageFile()
  const entries: AgentSkillEntry[] = []

  let dirEntries: fs.Dirent[]
  try {
    dirEntries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }

  for (const entry of dirEntries) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('.')) continue

    const skillMdPath = path.join(dir, entry.name, 'SKILL.md')
    if (!fs.existsSync(skillMdPath)) continue

    try {
      const content = fs.readFileSync(skillMdPath, 'utf-8')
      const parsed = parseSkillMd(content)
      entries.push({
        name: parsed.name,
        description: parsed.description,
        location: path.join(dir, entry.name),
        lastUsed: usage[parsed.name] ?? usage[entry.name],
      })
    } catch {
      // Skip skills with invalid SKILL.md
    }
  }

  return entries
}

/**
 * Track usage of an agent skill by updating the timestamp in .usage.json.
 */
export function trackAgentSkillUsage(skillName: string): void {
  try {
    const usage = readUsageFile()
    usage[skillName] = new Date().toISOString()
    writeUsageFile(usage)
  } catch {
    // Silently fail if directory is not writable
  }
}

/**
 * Get the N most recently used agent skills, sorted by lastUsed descending.
 */
export function getRecentAgentSkills(limit: number = 10): AgentSkillEntry[] {
  const allSkills = listAgentSkills()

  // Separate skills with usage data from those without
  const withUsage = allSkills.filter(s => s.lastUsed)
  const withoutUsage = allSkills.filter(s => !s.lastUsed)

  // Sort by lastUsed descending
  withUsage.sort((a, b) => {
    const timeA = new Date(a.lastUsed!).getTime()
    const timeB = new Date(b.lastUsed!).getTime()
    return timeB - timeA
  })

  // Combine: recently used first, then unused
  const combined = [...withUsage, ...withoutUsage]
  return combined.slice(0, limit)
}

/**
 * Get agent skills formatted for system prompt injection.
 * Returns the 10 most recently used skills as SkillPromptEntry[].
 */
export function getAgentSkillsForPrompt(): SkillPromptEntry[] {
  const recent = getRecentAgentSkills(10)
  return recent.map(s => ({
    name: s.name,
    description: s.description,
    location: s.location,
  }))
}

/**
 * Get the total count of agent skills (for overflow note).
 */
export function getAgentSkillsCount(): number {
  const dir = getAgentSkillsDir()
  if (!fs.existsSync(dir)) return 0

  let count = 0
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const skillMdPath = path.join(dir, entry.name, 'SKILL.md')
      if (fs.existsSync(skillMdPath)) count++
    }
  } catch {
    // Directory read failed
  }
  return count
}

/**
 * Create the list_agent_skills tool for agent discovery.
 */
export function createAgentSkillTools(): AgentTool[] {
  const listTool: AgentTool = {
    name: 'list_agent_skills',
    label: 'List Agent Skills',
    description:
      'List all self-created agent skills with their descriptions and file locations. ' +
      'Use this when you need a skill you haven\'t used recently or want to browse all available agent skills.',
    parameters: Type.Object({}),
    execute: async () => {
      try {
        const skills = listAgentSkills()
        if (skills.length === 0) {
          return {
            content: [{ type: 'text' as const, text: 'No agent skills found. You can create skills by writing SKILL.md files to the agent skills directory.' }],
            details: { count: 0 },
          }
        }

        const lines = skills.map(s => {
          const lastUsedStr = s.lastUsed ? ` (last used: ${s.lastUsed})` : ''
          return `- **${s.name}**: ${s.description}\n  Location: ${s.location}${lastUsedStr}`
        })

        const dir = getAgentSkillsDir()
        const text = `Found ${skills.length} agent skill(s):\n\n${lines.join('\n\n')}\n\nSkills directory: ${dir}`

        return {
          content: [{ type: 'text' as const, text }],
          details: { count: skills.length },
        }
      } catch (err: unknown) {
        return {
          content: [{ type: 'text' as const, text: `Error listing agent skills: ${(err as Error).message}` }],
          details: { error: true },
        }
      }
    },
  }

  return [listTool]
}
