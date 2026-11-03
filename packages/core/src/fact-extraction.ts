import type { Api, Model } from '@earendil-works/pi-ai'
import { completeSimple } from './pi-models.js'
import { logCompletionUsage } from './completion-usage.js'
import type { Database } from './database.js'
import { createMemory, supersedeMemories } from './memories-store.js'
import { assertLlmResponseOk } from './llm-response.js'
import { resolveBackgroundReasoning } from './thinking-level.js'

const MAX_FACTS = 10
const RELATED_SEARCH_LIMIT = 25
const MAX_RELATED_PER_FACT = 5

const COMMON_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'das', 'der', 'die', 'ein', 'eine', 'einer', 'einem', 'einen',
  'for', 'from', 'i', 'ich', 'in', 'is', 'it', 'mit', 'of', 'on', 'or', 'the', 'to', 'und', 'user', 'uses', 'with',
])

const systemPrompt = `You are a fact extraction assistant. Your job is to extract atomic, reusable facts from a conversation transcript.

Rules:
- Extract a maximum of 10 facts per transcript
- Each fact must be a single, self-contained statement
- Facts should be things worth remembering long-term (preferences, decisions, technical details, personal info)
- Do NOT extract ephemeral details (greetings, temporary commands, one-off questions)
- Do NOT extract opinions or subjective assessments by the assistant
- Write each fact on its own line, prefixed with "- "
- Write facts in the same language as the conversation
- If no facts worth remembering are found, respond with: NO_FACTS
- An <earlier_context> block, if present, only helps you understand the transcript. Its facts were already extracted; extract facts from <transcript> only

Example output:
- User prefers dark mode in all applications
- The project uses PostgreSQL on port 5433 (non-standard)
- Deployment is done via Docker Compose with 3 services`

const reconciliationSystemPrompt = `You maintain a long-term fact memory. Compare newly extracted facts with existing facts from the same user.

For every new fact, decide exactly one of:
- ADD: the new fact is new information
- SKIP: an existing fact already says the same thing
- SUPERSEDES #<id>[, #<id>...]: the new fact corrects, updates or contradicts the listed existing facts, which will be retired

Rules:
- Supersede only when the new fact clearly replaces the existing one (changed preference, corrected value, outdated state)
- Related but compatible facts are not superseded; use ADD for those
- Only reference ids from the existing facts list
- Answer with one line per new fact in the form "N<number>: <decision>" and nothing else

Example output:
N1: ADD
N2: SUPERSEDES #42
N3: SKIP`

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

export interface RelatedFact {
  id: number
  content: string
  /** Normalized word overlap with the new fact, 1 means the same words. */
  overlap: number
}

/**
 * Find active facts of the same user that share keywords with `newFact`,
 * most similar first. Retired (superseded) facts are never returned.
 */
export function findRelatedFacts(
  db: Database,
  userId: number | null,
  newFact: string,
  limit: number = RELATED_SEARCH_LIMIT,
): RelatedFact[] {
  const normalizedFact = normalizeWhitespace(newFact)
  if (!normalizedFact) return []

  const keywords = getSearchKeywords(normalizedFact)
  const fallbackWords = getNormalizedWords(normalizedFact).slice(0, 6)
  const queryTerms = keywords.length > 0 ? keywords : fallbackWords
  if (queryTerms.length === 0) return []

  const candidates = db.prepare(`
    SELECT m.id, m.content
    FROM memories_fts
    INNER JOIN memories m ON m.id = memories_fts.rowid
    WHERE memories_fts MATCH ? AND m.user_id IS ? AND m.deleted_at IS NULL
    ORDER BY bm25(memories_fts) ASC, m.timestamp DESC, m.id DESC
    LIMIT ?
  `).all(buildFtsOrQuery(queryTerms), userId, limit) as Array<{ id: number; content: string }>

  return candidates
    .map(candidate => ({ ...candidate, overlap: computeWordOverlap(candidate.content, normalizedFact) }))
    .sort((a, b) => b.overlap - a.overlap)
}

/**
 * Store a single extracted fact in the memories table.
 */
export function storeFact(db: Database, userId: number | null, sessionId: string, content: string): number {
  return createMemory(db, userId, sessionId, normalizeWhitespace(content), 'extracted_fact')
}

export type FactDecision =
  | { action: 'add' }
  | { action: 'skip' }
  | { action: 'supersede'; ids: number[] }

/**
 * Parse the reconciliation answer into one decision per new fact (index-aligned).
 * Facts the model did not answer for default to `add`, which matches the
 * behaviour before reconciliation existed. Superseded ids outside
 * `allowedIds` are dropped so the model cannot retire facts it was not shown.
 */
export function parseFactDecisions(
  response: string,
  factCount: number,
  allowedIds: ReadonlySet<number>,
): FactDecision[] {
  const decisions: FactDecision[] = Array.from({ length: factCount }, () => ({ action: 'add' as const }))

  for (const line of response.split(/\r?\n/)) {
    const match = line.trim().match(/^[-*•]?\s*\[?N(\d+)\]?\s*[:.)-]\s*(ADD|SKIP|SUPERSEDES?)\b(.*)$/i)
    if (!match) continue

    const index = Number.parseInt(match[1], 10) - 1
    if (index < 0 || index >= factCount) continue

    const action = match[2].toUpperCase()
    if (action === 'SKIP') {
      decisions[index] = { action: 'skip' }
    } else if (action.startsWith('SUPERSEDE')) {
      const ids = Array.from(match[3].matchAll(/#\s*(\d+)/g), idMatch => Number.parseInt(idMatch[1], 10))
        .filter(id => allowedIds.has(id))
      decisions[index] = ids.length > 0 ? { action: 'supersede', ids } : { action: 'add' }
    }
  }

  return decisions
}

async function completeText(model: Model<Api>, apiKey: string, systemPrompt: string, userMessage: string, context: string): Promise<string> {
  const response = await completeSimple(model, {
    systemPrompt,
    messages: [{
      role: 'user' as const,
      content: userMessage,
      timestamp: Date.now(),
    }],
  }, {
    apiKey,
    reasoning: resolveBackgroundReasoning(),
  })
  logCompletionUsage({ db, sessionId, userId }, model, response)

  assertLlmResponseOk(response, context)

  return response.content
    .filter(item => item.type === 'text')
    .map(item => (item as { type: 'text'; text: string }).text)
    .join('')
    .trim()
}

function buildReconciliationMessage(facts: readonly string[], relatedFacts: readonly RelatedFact[]): string {
  const existing = relatedFacts.map(fact => `[#${fact.id}] ${fact.content}`).join('\n')
  const incoming = facts.map((fact, index) => `N${index + 1}: ${fact}`).join('\n')
  return `<existing_facts>\n${existing}\n</existing_facts>\n\n<new_facts>\n${incoming}\n</new_facts>`
}

async function reconcileWithExistingFacts(
  model: Model<Api>,
  apiKey: string,
  facts: readonly string[],
  relatedFacts: readonly RelatedFact[],
): Promise<FactDecision[]> {
  if (relatedFacts.length === 0) {
    return facts.map(() => ({ action: 'add' }))
  }

  const responseText = await completeText(
    model,
    apiKey,
    reconciliationSystemPrompt,
    buildReconciliationMessage(facts, relatedFacts),
    '[fact-extraction] Provider rejected the reconciliation request',
  )

  return parseFactDecisions(responseText, facts.length, new Set(relatedFacts.map(fact => fact.id)))
}

function collectRelatedFacts(db: Database, userId: number | null, facts: readonly string[]): {
  newFacts: string[]
  exactDuplicates: number
  relatedFacts: RelatedFact[]
} {
  const newFacts: string[] = []
  const seenWordSets = new Set<string>()
  const relatedById = new Map<number, RelatedFact>()
  let exactDuplicates = 0

  for (const fact of facts) {
    const wordSet = getNormalizedWords(fact).sort().join(' ')
    const related = findRelatedFacts(db, userId, fact)
    if (seenWordSets.has(wordSet) || related.some(candidate => candidate.overlap === 1)) {
      exactDuplicates += 1
      continue
    }

    seenWordSets.add(wordSet)
    newFacts.push(fact)
    for (const candidate of related.slice(0, MAX_RELATED_PER_FACT)) {
      relatedById.set(candidate.id, candidate)
    }
  }

  return { newFacts, exactDuplicates, relatedFacts: [...relatedById.values()] }
}

export interface FactExtractionResult {
  extracted: number
  stored: number
  duplicates: number
  superseded: number
}

/** LLM output of one extraction run, ready to be written by {@link applyFactExtractionPlan}. */
export interface FactExtractionPlan {
  extracted: number
  exactDuplicates: number
  newFacts: string[]
  decisions: FactDecision[]
}

export interface FactExtractionOptions {
  /** Already processed transcript lines shown for context only. */
  earlierContext?: string
}

function buildExtractionMessage(conversationHistory: string, earlierContext: string | undefined): string {
  const contextBlock = earlierContext ? `<earlier_context>\n${earlierContext}\n</earlier_context>\n\n` : ''
  return `Analyze the following session transcript and extract atomic facts worth remembering:\n\n${contextBlock}<transcript>\n${conversationHistory}\n</transcript>`
}

/**
 * Run the extraction and reconciliation LLM calls without writing anything.
 */
export async function planFactExtraction(
  db: Database,
  userId: number | null,
  conversationHistory: string,
  model: Model<Api>,
  apiKey: string,
  options: FactExtractionOptions = {},
): Promise<FactExtractionPlan> {
  const responseText = await completeText(
    model,
    apiKey,
    systemPrompt,
    buildExtractionMessage(conversationHistory, options.earlierContext),
    '[fact-extraction] Provider rejected the extraction request',
  )

  const facts = parseFactLines(responseText)
  const { newFacts, exactDuplicates, relatedFacts } = collectRelatedFacts(db, userId, facts)
  const decisions = await reconcileWithExistingFacts(model, apiKey, newFacts, relatedFacts)

  return { extracted: facts.length, exactDuplicates, newFacts, decisions }
}

/**
 * Write a plan in one transaction. Safe to call inside an outer transaction
 * (better-sqlite3 nests it as a savepoint), so callers can commit their own
 * bookkeeping atomically with the facts.
 */
export function applyFactExtractionPlan(
  db: Database,
  userId: number | null,
  sessionId: string,
  plan: FactExtractionPlan,
): FactExtractionResult {
  let stored = 0
  let skipped = 0
  let superseded = 0

  db.transaction(() => {
    plan.newFacts.forEach((fact, index) => {
      const decision = plan.decisions[index]
      if (decision.action === 'skip') {
        skipped += 1
        return
      }

      const factId = storeFact(db, userId, sessionId, fact)
      stored += 1
      if (decision.action === 'supersede') {
        superseded += supersedeMemories(db, userId, decision.ids, factId).length
      }
    })
  })()

  return {
    extracted: plan.extracted,
    stored,
    duplicates: plan.exactDuplicates + skipped,
    superseded,
  }
}

/**
 * Extract facts from a conversation transcript and reconcile them with the
 * user's existing facts: duplicates are skipped, corrections supersede the
 * facts they replace, everything else is stored as a new fact.
 */
export async function extractAndStoreFacts(
  db: Database,
  userId: number | null,
  sessionId: string,
  conversationHistory: string,
  model: Model<Api>,
  apiKey: string,
): Promise<FactExtractionResult> {
  const plan = await planFactExtraction(db, userId, conversationHistory, model, apiKey)
  return applyFactExtractionPlan(db, userId, sessionId, plan)
}
