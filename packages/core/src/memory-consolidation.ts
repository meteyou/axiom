import fs from 'node:fs'
import path from 'node:path'
import { completeSimple } from '@mariozechner/pi-ai'
import type { Api, Model, Context } from '@mariozechner/pi-ai'
import { getMemoryDir, ensureMemoryStructure, readMemoryFile, writeMemoryFile } from './memory.js'

export interface MemoryConsolidationOptions {
  /** Directory containing memory files */
  memoryDir?: string
  /** Number of past days of daily files to review (default: 3) */
  lookbackDays?: number
  /** pi-ai model to use for the consolidation LLM call */
  model: Model<Api>
  /** API key for the model */
  apiKey: string
}

export interface ConsolidationResult {
  /** Whether MEMORY.md was actually updated */
  updated: boolean
  /** The new MEMORY.md content (only if updated) */
  newContent?: string
  /** Number of daily files that were reviewed */
  dailyFilesReviewed: number
  /** Reason if not updated */
  reason?: string
  /** Token usage from the LLM call */
  usage?: {
    input: number
    output: number
  }
}

/**
 * Read daily memory files for the last N days.
 * Returns an array of { date, content } sorted oldest-first.
 */
export function readDailyFilesForConsolidation(
  days: number,
  memoryDir?: string,
): Array<{ date: string; content: string }> {
  const dir = memoryDir ?? getMemoryDir()
  const dailyDir = path.join(dir, 'daily')

  if (!fs.existsSync(dailyDir)) {
    return []
  }

  const now = new Date()
  const results: Array<{ date: string; content: string }> = []

  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    const dateStr = d.toISOString().split('T')[0]
    const filePath = path.join(dailyDir, `${dateStr}.md`)

    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8').trim()
      // Skip files that are just the header with no real content
      if (content && content !== `# Daily Memory — ${dateStr}`) {
        results.push({ date: dateStr, content })
      }
    }
  }

  return results
}

/**
 * Build the prompt for the consolidation LLM call.
 */
export function buildConsolidationPrompt(
  currentMemory: string,
  dailyEntries: Array<{ date: string; content: string }>,
): Context {
  const dailyBlock = dailyEntries
    .map(e => `--- ${e.date} ---\n${e.content}`)
    .join('\n\n')

  const systemPrompt = `You are a memory consolidation assistant. Your job is to review recent daily memory entries and decide whether the core memory file (MEMORY.md) needs to be updated.

The core memory file contains important, long-term information: learned lessons, user preferences, technical notes, recurring patterns, and anything that should persist across sessions.

Daily memory files contain session-specific notes, observations, and events from individual days. Most daily entries are ephemeral and don't need to be preserved. But some contain valuable insights, preferences, or lessons that should be promoted to core memory.

## Rules

1. **Be selective**: Only promote information that has lasting value. Don't add ephemeral details.
2. **Merge, don't duplicate**: If the core memory already contains similar information, update/refine it rather than adding duplicates.
3. **Preserve structure**: Keep the existing markdown structure of MEMORY.md. Add new sections if needed, but keep it organized.
4. **Remove outdated info**: If daily entries contradict or update existing core memory, update the core memory accordingly.
5. **Be concise**: Core memory should be scannable. Use bullet points and short descriptions.

## Response format

If NO update is needed, respond with exactly:
NO_UPDATE

If an update IS needed, respond with the complete new content for MEMORY.md (the full file, not a diff). Start directly with the markdown content.`

  const userMessage = `## Current MEMORY.md

${currentMemory}

## Recent Daily Entries

${dailyBlock}

Review these daily entries and decide: does MEMORY.md need to be updated? If yes, output the complete new MEMORY.md content. If no, output NO_UPDATE.`

  return {
    systemPrompt,
    messages: [
      {
        role: 'user' as const,
        content: userMessage,
        timestamp: Date.now(),
      },
    ],
  }
}

/**
 * Run the memory consolidation process.
 *
 * Reads the last N days of daily memory files, sends them along with the current
 * MEMORY.md to an LLM, and updates MEMORY.md if the LLM determines changes are needed.
 */
export async function consolidateMemory(
  options: MemoryConsolidationOptions,
): Promise<ConsolidationResult> {
  const memoryDir = options.memoryDir
  const lookbackDays = options.lookbackDays ?? 3

  // Ensure memory structure exists
  ensureMemoryStructure(memoryDir)

  // Read daily files
  const dailyEntries = readDailyFilesForConsolidation(lookbackDays, memoryDir)

  if (dailyEntries.length === 0) {
    return {
      updated: false,
      dailyFilesReviewed: 0,
      reason: 'No daily memory files with content found',
    }
  }

  // Read current core memory
  const currentMemory = readMemoryFile(memoryDir)

  // Build the prompt
  const context = buildConsolidationPrompt(currentMemory, dailyEntries)

  // Call the LLM
  const response = await completeSimple(options.model, context, {
    apiKey: options.apiKey,
  })

  const responseText = response.content
    .filter(c => c.type === 'text')
    .map(c => (c as { type: 'text'; text: string }).text)
    .join('')
    .trim()

  const usage = {
    input: response.usage.input,
    output: response.usage.output,
  }

  // Check if the LLM decided no update is needed
  if (responseText === 'NO_UPDATE' || responseText.startsWith('NO_UPDATE')) {
    return {
      updated: false,
      dailyFilesReviewed: dailyEntries.length,
      reason: 'LLM determined no update needed',
      usage,
    }
  }

  // Write the updated MEMORY.md
  writeMemoryFile(responseText, memoryDir)

  return {
    updated: true,
    newContent: responseText,
    dailyFilesReviewed: dailyEntries.length,
    usage,
  }
}
