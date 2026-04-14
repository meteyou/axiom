import type { AgentTool } from '@mariozechner/pi-agent-core'
import { Type } from '@mariozechner/pi-ai'
import type { Database } from './database.js'
import { searchMemories } from './memories-store.js'

export interface SearchMemoriesToolOptions {
  db: Database
  getCurrentUserId?: () => number | undefined
}

export function createSearchMemoriesTool(options: SearchMemoriesToolOptions): AgentTool {
  return {
    name: 'search_memories',
    label: 'Search Memories',
    description:
      'Search the agent\'s fact memory for previously learned information. ' +
      'Returns atomic facts extracted from past conversations. ' +
      'Use this when the user asks about past decisions, preferences, or details discussed in earlier sessions. ' +
      'Supports FTS5 query syntax: word matching, prefix queries (e.g. "config*"), ' +
      'phrase matching (e.g. "postgres port"), and boolean operators (e.g. "docker OR container").',
    parameters: Type.Object({
      query: Type.String({
        description: 'Search query for finding relevant facts from memory.',
      }),
      limit: Type.Optional(
        Type.Number({
          description: 'Maximum number of facts to return (default: 10, max: 50).',
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const { query, limit: rawLimit } = params as { query?: string; limit?: number }

      if (typeof query !== 'string' || query.trim().length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'Error: query must be a non-empty string.' }],
          details: { error: true },
        }
      }

      if (rawLimit !== undefined && (!Number.isFinite(rawLimit) || rawLimit < 1)) {
        return {
          content: [{ type: 'text' as const, text: 'Error: limit must be a positive number.' }],
          details: { error: true },
        }
      }

      try {
        const limit = Math.min(Math.max(Math.floor(rawLimit ?? 10), 1), 50)
        const userId = options.getCurrentUserId?.()
        const facts = searchMemories(options.db, query, {
          userId,
          limit,
        })

        if (facts.length === 0) {
          return {
            content: [{ type: 'text' as const, text: `No memories found for query "${query}".` }],
            details: {
              count: 0,
              query,
              limit,
              userId,
            },
          }
        }

        const formatted = facts.map((fact, index) => {
          const header = `${index + 1}. [${fact.timestamp}] [${fact.source}]`
          const sessionLine = fact.sessionId ? `Session: ${fact.sessionId}\n` : ''
          return `${header}\n${sessionLine}${fact.content}`
        }).join('\n\n')

        return {
          content: [{ type: 'text' as const, text: formatted }],
          details: {
            count: facts.length,
            query,
            limit,
            userId,
            facts,
          },
        }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: 'text' as const, text: `Error searching memories: ${errorMessage}` }],
          details: { error: true },
        }
      }
    },
  }
}
