import type { AgentTool } from '@mariozechner/pi-agent-core'
import { Type } from '@mariozechner/pi-ai'
import { readAgentsFile, writeAgentsFile, readDailyFile, appendToDailyFile } from './memory.js'

/**
 * Create agent tools for interacting with the memory system
 */
export function createMemoryTools(memoryDir?: string): AgentTool[] {
  const readCoreMemoryTool: AgentTool = {
    name: 'read_core_memory',
    label: 'Read Core Memory',
    description: 'Read the AGENTS.md core memory file. This contains learned lessons, important notes, and technical instructions that persist across sessions.',
    parameters: Type.Object({}),
    execute: async () => {
      try {
        const content = readAgentsFile(memoryDir)
        return {
          content: [{ type: 'text' as const, text: content }],
          details: { success: true },
        }
      } catch (err: unknown) {
        return {
          content: [{ type: 'text' as const, text: `Error reading core memory: ${(err as Error).message}` }],
          details: { error: true },
        }
      }
    },
  }

  const writeCoreMemoryTool: AgentTool = {
    name: 'write_core_memory',
    label: 'Write Core Memory',
    description: 'Overwrite the AGENTS.md core memory file. Use this to persist important lessons, rules, or technical notes across sessions. Be careful: this replaces the entire file.',
    parameters: Type.Object({
      content: Type.String({ description: 'The full new content for the AGENTS.md file' }),
    }),
    execute: async (_toolCallId, params) => {
      const { content } = params as { content: string }
      try {
        writeAgentsFile(content, memoryDir)
        return {
          content: [{ type: 'text' as const, text: `Successfully updated core memory (${content.length} bytes)` }],
          details: { success: true, size: content.length },
        }
      } catch (err: unknown) {
        return {
          content: [{ type: 'text' as const, text: `Error writing core memory: ${(err as Error).message}` }],
          details: { error: true },
        }
      }
    },
  }

  const readDailyMemoryTool: AgentTool = {
    name: 'read_daily_memory',
    label: 'Read Daily Memory',
    description: 'Read the daily memory file for a specific date (defaults to today). Contains session summaries and notes for that day.',
    parameters: Type.Object({
      date: Type.Optional(Type.String({ description: 'Date in YYYY-MM-DD format (defaults to today)' })),
    }),
    execute: async (_toolCallId, params) => {
      const { date: dateStr } = params as { date?: string }
      try {
        const date = dateStr ? new Date(dateStr + 'T12:00:00Z') : undefined
        const content = readDailyFile(date, memoryDir)
        return {
          content: [{ type: 'text' as const, text: content }],
          details: { success: true },
        }
      } catch (err: unknown) {
        return {
          content: [{ type: 'text' as const, text: `Error reading daily memory: ${(err as Error).message}` }],
          details: { error: true },
        }
      }
    },
  }

  const appendDailyMemoryTool: AgentTool = {
    name: 'append_daily_memory',
    label: 'Append to Daily Memory',
    description: 'Append content to today\'s daily memory file. Use this to record important events, discoveries, or notes during the session.',
    parameters: Type.Object({
      content: Type.String({ description: 'Content to append to today\'s daily memory file' }),
      date: Type.Optional(Type.String({ description: 'Date in YYYY-MM-DD format (defaults to today)' })),
    }),
    execute: async (_toolCallId, params) => {
      const { content, date: dateStr } = params as { content: string; date?: string }
      try {
        const date = dateStr ? new Date(dateStr + 'T12:00:00Z') : undefined
        appendToDailyFile(content, date, memoryDir)
        return {
          content: [{ type: 'text' as const, text: `Successfully appended ${content.length} bytes to daily memory` }],
          details: { success: true, size: content.length },
        }
      } catch (err: unknown) {
        return {
          content: [{ type: 'text' as const, text: `Error appending to daily memory: ${(err as Error).message}` }],
          details: { error: true },
        }
      }
    },
  }

  return [readCoreMemoryTool, writeCoreMemoryTool, readDailyMemoryTool, appendDailyMemoryTool]
}
