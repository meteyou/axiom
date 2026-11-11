import type { Api, Model } from '@earendil-works/pi-ai'
import type { Database } from './database.js'
import { formatConversationLine, loadSessionTreeMessages } from './conversation-transcript.js'
import {
  advanceFactExtractionCursor,
  getFactExtractionCursorState,
  recordFactExtractionFailure,
} from './fact-extraction-cursor-store.js'
import { applyFactExtractionPlan, planFactExtraction } from './fact-extraction.js'
import type { FactExtractionResult } from './fact-extraction.js'

/** Same size the one-shot extraction used to cut the whole session to. */
export const FACT_EXTRACTION_CHUNK_CHARS = 12000
const EARLIER_CONTEXT_CHARS = 2000
/** Runs in a row that may fail on the chunk after the cursor before it is skipped. */
export const MAX_FACT_EXTRACTION_CHUNK_ATTEMPTS = 3

export interface TranscriptChunk {
  text: string
  /** Tail of the transcript before this chunk, for context only. */
  earlierContext: string
  /** Highest `chat_messages.id` covered by this chunk; becomes the cursor once it is processed. */
  throughMessageId: number
}

export interface IncrementalFactExtractionResult extends FactExtractionResult {
  chunks: number
  skippedChunks: number
}

interface PendingEntry {
  id: number
  line: string | null
}

interface ChunkDraft {
  lines: string[]
  length: number
  throughMessageId: number
}

function groupIntoChunks(entries: readonly PendingEntry[], maxChars: number): ChunkDraft[] {
  const drafts: ChunkDraft[] = []
  for (const { id, line } of entries) {
    const current = drafts.at(-1)
    if (line === null) {
      if (current) current.throughMessageId = id
    } else if (!current || current.length + 1 + line.length > maxChars) {
      drafts.push({ lines: [line], length: line.length, throughMessageId: id })
    } else {
      current.lines.push(line)
      current.length += 1 + line.length
      current.throughMessageId = id
    }
  }
  return drafts
}

/**
 * Split the not yet extracted part of a session tree into chunks of at most
 * `maxChars`, cut at message boundaries. A single message longer than a chunk
 * is truncated. Messages without a transcript line (tool rows, ...) still move
 * the cursor of the chunk before them so they are not looked at again.
 * Messages after `upToMessageId` are ignored.
 */
export function buildPendingTranscriptChunks(
  db: Database,
  sessionId: string,
  afterMessageId: number,
  upToMessageId: number,
  maxChars: number = FACT_EXTRACTION_CHUNK_CHARS,
): TranscriptChunk[] {
  const messages = loadSessionTreeMessages(db, sessionId, 'id').filter(message => message.id <= upToMessageId)
  const transcriptSoFar = messages
    .filter(message => message.id <= afterMessageId)
    .map(formatConversationLine)
    .filter((line): line is string => line !== null)
  const pending = messages
    .filter(message => message.id > afterMessageId)
    .map(message => ({ id: message.id, line: formatConversationLine(message)?.slice(0, maxChars) ?? null }))

  return groupIntoChunks(pending, maxChars).map(draft => {
    const earlierContext = transcriptSoFar.join('\n').slice(-EARLIER_CONTEXT_CHARS)
    transcriptSoFar.push(...draft.lines)
    return { text: draft.lines.join('\n'), earlierContext, throughMessageId: draft.throughMessageId }
  })
}

export interface IncrementalFactExtractionOptions {
  db: Database
  userId: number | null
  sessionId: string
  /**
   * Last message to cover. Capture it synchronously when the extraction is
   * triggered: rows of a turn that starts later may still be discarded on a
   * retryable error, and facts must not be extracted from them.
   */
  upToMessageId: number
  model: Model<Api>
  apiKey: string
}

async function runIncrementalFactExtraction(options: IncrementalFactExtractionOptions): Promise<IncrementalFactExtractionResult> {
  const { db, userId, sessionId, upToMessageId, model, apiKey } = options
  const total: IncrementalFactExtractionResult = { chunks: 0, skippedChunks: 0, extracted: 0, stored: 0, duplicates: 0, superseded: 0 }

  // A chunk the provider keeps rejecting would otherwise block every later message of the session.
  const cursor = getFactExtractionCursorState(db, sessionId)
  let afterMessageId = cursor.lastMessageId
  if (cursor.failedAttempts >= MAX_FACT_EXTRACTION_CHUNK_ATTEMPTS && cursor.failedThroughMessageId !== null) {
    console.error(
      `[fact-extraction] Skipping messages ${cursor.lastMessageId + 1}-${cursor.failedThroughMessageId} of session ${sessionId}: `
      + `extraction failed ${cursor.failedAttempts} times in a row`,
    )
    advanceFactExtractionCursor(db, sessionId, cursor.failedThroughMessageId)
    afterMessageId = cursor.failedThroughMessageId
    total.skippedChunks += 1
  }

  const chunks = buildPendingTranscriptChunks(db, sessionId, afterMessageId, upToMessageId)

  for (const chunk of chunks) {
    let plan: Awaited<ReturnType<typeof planFactExtraction>>
    try {
      plan = await planFactExtraction(db, userId, chunk.text, model, apiKey, { earlierContext: chunk.earlierContext, sessionId })
    } catch (err) {
      recordFactExtractionFailure(db, sessionId, chunk.throughMessageId)
      throw err
    }
    const result = db.transaction(() => {
      const applied = applyFactExtractionPlan(db, userId, sessionId, plan)
      advanceFactExtractionCursor(db, sessionId, chunk.throughMessageId)
      return applied
    })()

    total.chunks += 1
    total.extracted += result.extracted
    total.stored += result.stored
    total.duplicates += result.duplicates
    total.superseded += result.superseded
  }

  return total
}

const runningExtractions = new Map<string, Promise<IncrementalFactExtractionResult>>()

/**
 * Extract facts from every message of the session tree that no earlier run
 * covered, chunk by chunk. The cursor moves in the same transaction that
 * stores a chunk's facts, so a failed chunk is retried by the next run and a
 * finished one is never extracted twice. Runs for the same session are
 * serialized: a second call waits for the first and then only picks up
 * messages that arrived in between.
 */
export function extractFactsIncrementally(options: IncrementalFactExtractionOptions): Promise<IncrementalFactExtractionResult> {
  const previous = runningExtractions.get(options.sessionId)
  const run = (previous ?? Promise.resolve())
    // The previous caller handles its own failure; this run only waits for it.
    .catch(() => undefined)
    .then(() => runIncrementalFactExtraction(options))
    .finally(() => {
      if (runningExtractions.get(options.sessionId) === run) runningExtractions.delete(options.sessionId)
    })
  runningExtractions.set(options.sessionId, run)
  return run
}
