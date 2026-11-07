import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from 'typebox'
import type { Database } from './database.js'
import { searchMemories } from './memories-store.js'
import type { MemoryFact } from './memories-store.js'
import { searchWiki } from './wiki-index.js'
import type { WikiSearchHit } from './wiki-index.js'

const MAX_WIKI_HITS = 10

export interface SearchMemoriesToolOptions {
  db: Database
  getCurrentUserId?: () => number | undefined
  /** Session identity of a caller without a user row; restricts results to facts from its own sessions. */
  getSessionUser?: () => string | undefined
  memoryDir?: string
}

function formatFacts(facts: MemoryFact[]): string {
  if (facts.length === 0) return 'No matching facts.'
  return facts.map((fact, index) => {
    const header = `${index + 1}. [${fact.timestamp}] [${fact.source}]`
    const sessionLine = fact.sessionId ? `Session: ${fact.sessionId}\n` : ''
    return `${header}\n${sessionLine}${fact.content}`
  }).join('\n\n')
}

function formatWikiHits(hits: WikiSearchHit[]): string {
  if (hits.length === 0) return 'No matching wiki pages.'
  return hits.map((hit, index) => {
    const aliasLine = hit.aliases.length > 0 ? `\nAliases: ${hit.aliases.join(', ')}` : ''
    return `${index + 1}. ${hit.title}\nPath: ${hit.path}${aliasLine}\n${hit.snippet}`
  }).join('\n\n')
}

export function createSearchMemoriesTool(options: SearchMemoriesToolOptions): AgentTool {
  return {
    name: 'memory_search',
    label: 'Search Memories',
    description:
      'Search the agent\'s memory: atomic facts from past conversations (fact memory) and the wiki knowledge base. ' +
      'Search before answering knowledge questions about projects, systems, people, past decisions, preferences or how things are usually done. ' +
      'Returns two groups: facts, and wiki hits with path, title, aliases and a snippet — open relevant wiki hits with `file_read` before answering. ' +
      'Plain queries match ANY of the keywords, ranked by relevance — ' +
      'so provide several related keywords (e.g. docker deployment server) rather than a full sentence. ' +
      'For strict matching, FTS5 syntax is supported: prefix queries (e.g. config*), ' +
      'quoted phrases (e.g. "postgres port"), and boolean operators (e.g. docker AND compose).',
    parameters: Type.Object({
      query: Type.String({
        description: 'Search query for finding relevant facts from memory.',
      }),
      limit: Type.Optional(
        Type.Number({
          description: 'Maximum number of facts to return (default: 10, max: 50). Wiki hits are capped at 10.',
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
          sessionUser: userId === undefined ? options.getSessionUser?.() : undefined,
          limit,
        })
        const wikiHits = searchWiki(options.db, query, {
          memoryDir: options.memoryDir,
          limit: Math.min(limit, MAX_WIKI_HITS),
        })

        const text = `## Facts\n\n${formatFacts(facts)}\n\n## Wiki\n\n${formatWikiHits(wikiHits)}`

        return {
          content: [{ type: 'text' as const, text }],
          details: {
            count: facts.length,
            wikiCount: wikiHits.length,
            query,
            limit,
            userId,
            facts,
            wikiHits,
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
