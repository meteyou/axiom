import type { Api, Model } from '@earendil-works/pi-ai'
import { completeSimple } from './pi-models.js'
import type { Database } from './database.js'
import { createMemory } from './memories-store.js'
import type { ProviderConfig } from './provider-config.js'
import { resolveModelTemperature } from './provider-config.js'
import { resolveBackgroundReasoning } from './thinking-level.js'

const MAX_FACTS = 10
const DUPLICATE_OVERLAP_THRESHOLD = 0.7
const DUPLICATE_SEARCH_LIMIT = 25

const COMMON_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'das', 'der', 'die', 'ein', 'eine', 'einer', 'einem', 'einen',
  'for', 'from', 'i', 'ich', 'in', 'is', 'it', 'mit', 'of', 'on', 'or', 'the', 'to', 'und', 'user', 'uses', 'with',
])

const systemPrompt = `You are a fact extraction assistant. Your job is to extract atomic, reusable facts from a conversation transcript.

Rules:
- Extract a maximum of 10 facts per conversation
- Each fact must be a single, self-contained statement
- Facts should be things worth remembering long-term (preferences, decisions, technical details, personal info)
- Do NOT extract ephemeral details (greetings, temporary commands, one-off questions)
- Do NOT extract opinions or subjective assessments by the assistant
- Write each fact on its own line, prefixed with "- "
- Write facts in the same language as the conversation
- If no facts worth remembering are found, respond with: NO_FACTS

Example output:
- User prefers dark mode in all applications
- The project uses PostgreSQL on port 5433 (non-standard)
- Deployment is done via Docker Compose with 3 services`

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function normalizeWord(word: string): string {
  return word
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
}

function getNormalizedWords(text: string): string[] {
  return Array.from(new Set(
    (text.match(/[\p{L}\p{N}]+/gu) ?? [])
      .map(normalizeWord)
      .filter(Boolean)
  ))
}

function getSearchKeywords(text: string): string[] {
  return getNormalizedWords(text)
    .filter(word => word.length >= 3 && !COMMON_WORDS.has(word))
    .sort((a, b) => b.length - a.length)
    .slice(0, 6)
}

function buildFtsOrQuery(keywords: string[]): string {
  return keywords
    .map(keyword => `"${keyword.replaceAll('"', '""')}"`)
    .join(' OR ')
}

function computeWordOverlap(a: string, b: string): number {
  const aWords = new Set(getNormalizedWords(a))
  const bWords = new Set(getNormalizedWords(b))

  if (aWords.size === 0 || bWords.size === 0) {
    return normalizeWhitespace(a).toLowerCase() === normalizeWhitespace(b).toLowerCase() ? 1 : 0
  }

  let intersection = 0
  for (const word of aWords) {
    if (bWords.has(word)) intersection += 1
  }

  return intersection / Math.max(aWords.size, bWords.size)
}

function normalizeFactCandidate(line: string): string {
  const trimmed = line.trim()
  if (!trimmed) return ''

  const withoutPrefix = trimmed
    .replace(/^[-*•]\s+/, '')
    .replace(/^\d+[.)]\s+/, '')

  return normalizeWhitespace(withoutPrefix)
}

interface CandidateRow {
  content: string
}

/**
 * Parse an LLM fact extraction response into a normalized fact array.
 */
export function parseFactLines(response: string): string[] {
  const trimmed = response.trim()
  if (!trimmed || trimmed.toUpperCase() === 'NO_FACTS') {
    return []
  }

  const lines = trimmed
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)

  const structuredFacts = lines
    .filter(line => /^([-*•]\s+|\d+[.)]\s+)/.test(line))
    .map(normalizeFactCandidate)
    .filter(Boolean)

  if (structuredFacts.length > 0) {
    return structuredFacts.slice(0, MAX_FACTS)
  }

  return lines
    .map(normalizeFactCandidate)
    .filter(Boolean)
    .slice(0, MAX_FACTS)
}

/**
 * Check whether a fact already exists for the same user.
 * Uses FTS5 candidate search followed by normalized word-overlap matching.
 */
export function isDuplicateFact(db: Database, userId: number | null, newFact: string): boolean {
  const normalizedFact = normalizeWhitespace(newFact)
  if (!normalizedFact) return false

  const keywords = getSearchKeywords(normalizedFact)
  const fallbackWords = getNormalizedWords(normalizedFact).slice(0, 6)
  const queryTerms = keywords.length > 0 ? keywords : fallbackWords
  if (queryTerms.length === 0) return false

  const ftsQuery = buildFtsOrQuery(queryTerms)
  const userClause = userId === null ? 'm.user_id IS NULL' : 'm.user_id = ?'
  const params = userId === null
    ? [ftsQuery, DUPLICATE_SEARCH_LIMIT]
    : [ftsQuery, userId, DUPLICATE_SEARCH_LIMIT]

  const candidates = db.prepare(`
    SELECT m.content
    FROM memories_fts
    INNER JOIN memories m ON m.id = memories_fts.rowid
    WHERE memories_fts MATCH ? AND ${userClause}
    ORDER BY bm25(memories_fts) ASC, m.timestamp DESC, m.id DESC
    LIMIT ?
  `).all(...params) as CandidateRow[]

  for (const candidate of candidates) {
    if (computeWordOverlap(candidate.content, normalizedFact) > DUPLICATE_OVERLAP_THRESHOLD) {
      return true
    }
  }

  return false
}

/**
 * Store a single extracted fact in the memories table.
 */
export function storeFact(db: Database, userId: number | null, sessionId: string, content: string): number {
  return createMemory(db, userId, sessionId, normalizeWhitespace(content), 'extracted_fact')
}

/**
 * Extract facts from a conversation transcript, deduplicate them, and store new facts.
 */
export async function extractAndStoreFacts(
  db: Database,
  userId: number | null,
  sessionId: string,
  conversationHistory: string,
  model: Model<Api>,
  apiKey: string,
  /**
   * Optional provider config owning the model. When supplied, the helper
   * honors per-model temperature constraints (e.g. Kimi K2 thinking models
   * require temperature=1). When omitted, temperature defaults to 0.
   */
  provider?: Pick<ProviderConfig, 'providerType' | 'models'>,
): Promise<{ extracted: number; stored: number; duplicates: number }> {
  const userMessage = `Analyze the following session transcript and extract atomic facts worth remembering:\n\n<transcript>\n${conversationHistory}\n</transcript>`

  const response = await completeSimple(model, {
    systemPrompt,
    messages: [{
      role: 'user' as const,
      content: userMessage,
      timestamp: Date.now(),
    }],
  }, {
    apiKey,
    temperature: provider ? resolveModelTemperature(provider, model.id, 0) : 0,
    reasoning: resolveBackgroundReasoning(),
  })

  const responseText = response.content
    .filter(item => item.type === 'text')
    .map(item => (item as { type: 'text'; text: string }).text)
    .join('')
    .trim()

  const facts = parseFactLines(responseText)
  let stored = 0
  let duplicates = 0

  for (const fact of facts) {
    if (isDuplicateFact(db, userId, fact)) {
      duplicates += 1
      continue
    }

    storeFact(db, userId, sessionId, fact)
    stored += 1
  }

  return {
    extracted: facts.length,
    stored,
    duplicates,
  }
}
