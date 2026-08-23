import { randomUUID } from 'node:crypto'
import type { Database } from './database.js'
import type { ResponseChunk, StallInfo, StallOutcome } from './agent-runtime-types.js'
import type { UploadDescriptor } from './uploads.js'
import { serializeUploadsMetadata } from './uploads.js'
import { extractUploadsFromToolResult } from './send-file-tool.js'
import {
  buildProviderStallMetadata,
  formatProviderStallContent,
  loadStallThresholds,
} from './provider-stall.js'
import type { StallThresholds } from './provider-stall.js'

/**
 * The slice of AgentCore the turn runner depends on. Keeping this narrow
 * makes the runner testable without a real agent and avoids a circular
 * dependency on `agent.ts`.
 */
export interface TurnAgentLike {
  sendMessage(
    userId: string,
    text: string,
    source?: string,
    attachments?: UploadDescriptor[],
  ): AsyncIterable<ResponseChunk>
  abort(): void
}

export interface TurnInfo {
  turnId: string
  userId: number
  sessionId: string
  startedAt: number
}

/**
 * Everything a consumer needs to render a turn. Emitted live and replayed
 * verbatim (with `replay: true`) when a consumer attaches mid-turn.
 */
export type TurnEvent =
  | { type: 'turn_start'; turnId: string; sessionId: string; replay?: boolean }
  | { type: 'chunk'; turnId: string; chunk: ResponseChunk; replay?: boolean }
  | { type: 'attachment'; turnId: string; attachment: UploadDescriptor; replay?: boolean }
  | { type: 'system'; turnId: string; text: string; replay?: boolean }
  | { type: 'turn_end'; turnId: string; replay?: boolean }

export type TurnSubscriber = (event: TurnEvent) => void

export interface StartTurnInput {
  userId: number
  sessionId: string
  text: string
  source?: string
  attachments?: UploadDescriptor[]
}

export interface TurnRunnerOptions {
  db: Database
  /** Resolves the live agent. May return null while the runtime boots. */
  getAgent: () => TurnAgentLike | null
  /**
   * Idle time before a "provider is slow" notice is emitted. Overrides
   * `settings.json` → `watchdog.stallWarnMs` (default 30 s).
   */
  stallWarnMs?: number
  /**
   * Idle time before the turn is hard-aborted. Overrides `settings.json` →
   * `watchdog.stallAbortMs` (default 90 s).
   */
  stallAbortMs?: number
  /** Watchdog tick interval (default 5 s). */
  watchdogIntervalMs?: number
  /**
   * How long a finished turn stays replayable. Covers the "refresh right as
   * the answer completes" case: the client strips its trailing assistant/tool
   * messages and rebuilds them from the replay, so no duplicates appear.
   */
  completedTurnRetentionMs?: number
  onTurnStart?: (turn: TurnInfo) => void
  onTurnEnd?: (turn: TurnInfo) => void
}

interface TurnState {
  id: string
  userId: number
  sessionId: string
  startedAt: number
  buffer: TurnEvent[]
  abortController: AbortController
  ended: boolean
  endedAt: number | null
}

const DEFAULT_WATCHDOG_INTERVAL_MS = 5_000
const DEFAULT_COMPLETED_TURN_RETENTION_MS = 60_000

function saveChatMessage(
  db: Database,
  sessionId: string,
  userId: number,
  role: 'user' | 'assistant' | 'tool' | 'system',
  content: string,
  metadata?: string,
): number {
  const result = db.prepare(
    'INSERT INTO chat_messages (session_id, user_id, role, content, metadata) VALUES (?, ?, ?, ?, ?)'
  ).run(sessionId, userId, role, content, metadata ?? null)
  return Number(result.lastInsertRowid)
}

function updateChatMessage(db: Database, id: number, content: string, metadata: string): void {
  db.prepare('UPDATE chat_messages SET content = ?, metadata = ? WHERE id = ?').run(content, metadata, id)
}

/**
 * Owns the full lifecycle of an agent turn, decoupled from any connection.
 *
 * A turn keeps running (and keeps persisting) when the driving socket goes
 * away; every event is buffered so late or reconnecting consumers can replay
 * the partial turn and then continue live. Turns are never recovered across a
 * process restart — the buffer is in-memory only and a lost turn simply ends.
 */
export class TurnRunner {
  private readonly db: Database
  private readonly getAgent: () => TurnAgentLike | null
  private readonly stallWarnMs?: number
  private readonly stallAbortMs?: number
  private readonly watchdogIntervalMs: number
  private readonly completedTurnRetentionMs: number
  private readonly onTurnStart?: (turn: TurnInfo) => void
  private readonly onTurnEnd?: (turn: TurnInfo) => void

  private readonly subscribers = new Map<number, Set<TurnSubscriber>>()
  /** Turns that are queued or streaming, per user. */
  private readonly liveTurns = new Map<number, Set<TurnState>>()
  /** Most recently finished turn per user, kept for the retention window. */
  private readonly recentTurns = new Map<number, TurnState>()
  /** Serializes turns per user so their chunk streams never interleave. */
  private readonly queues = new Map<number, Promise<void>>()

  constructor(options: TurnRunnerOptions) {
    this.db = options.db
    this.getAgent = options.getAgent
    this.stallWarnMs = options.stallWarnMs
    this.stallAbortMs = options.stallAbortMs
    this.watchdogIntervalMs = options.watchdogIntervalMs ?? DEFAULT_WATCHDOG_INTERVAL_MS
    this.completedTurnRetentionMs = options.completedTurnRetentionMs ?? DEFAULT_COMPLETED_TURN_RETENTION_MS
    this.onTurnStart = options.onTurnStart
    this.onTurnEnd = options.onTurnEnd
  }

  /**
   * Register a consumer for every turn of `userId`. If a turn is currently
   * running (or finished within the retention window) its buffered events are
   * replayed synchronously, flagged with `replay: true`, before any live event
   * is delivered.
   */
  subscribe(userId: number, subscriber: TurnSubscriber): () => void {
    let set = this.subscribers.get(userId)
    if (!set) {
      set = new Set()
      this.subscribers.set(userId, set)
    }
    set.add(subscriber)

    const replayTarget = this.getReplayableTurn(userId)
    if (replayTarget) {
      for (const event of replayTarget.buffer) {
        try {
          subscriber({ ...event, replay: true })
        } catch (err) {
          console.error('[turn-runner] replay subscriber failed:', err)
        }
      }
    }

    return () => {
      const current = this.subscribers.get(userId)
      if (!current) return
      current.delete(subscriber)
      if (current.size === 0) this.subscribers.delete(userId)
    }
  }

  /** True while a turn for this user is queued or streaming. */
  hasActiveTurn(userId: number): boolean {
    const turns = this.liveTurns.get(userId)
    if (!turns) return false
    for (const turn of turns) {
      if (!turn.ended) return true
    }
    return false
  }

  /**
   * Start a turn. Returns immediately — the turn runs in the background and
   * reports exclusively through subscribers. Concurrent starts for the same
   * user are queued so their streams stay ordered.
   */
  startTurn(input: StartTurnInput): TurnInfo {
    const turn: TurnState = {
      id: randomUUID(),
      userId: input.userId,
      sessionId: input.sessionId,
      startedAt: Date.now(),
      buffer: [],
      abortController: new AbortController(),
      ended: false,
      endedAt: null,
    }

    let turns = this.liveTurns.get(input.userId)
    if (!turns) {
      turns = new Set()
      this.liveTurns.set(input.userId, turns)
    }
    turns.add(turn)

    const previous = this.queues.get(input.userId) ?? Promise.resolve()
    const run = previous
      .catch(() => undefined)
      .then(() => this.runTurn(turn, input))
      .catch((err) => {
        console.error('[turn-runner] turn failed unexpectedly:', err)
      })
    this.queues.set(input.userId, run)

    return toInfo(turn)
  }

  /**
   * Abort every queued/streaming turn of a user (the `/stop` command, `/new`,
   * or an explicit kill). Returns true when something was actually aborted.
   */
  abortTurn(userId: number): boolean {
    const turns = this.liveTurns.get(userId)
    if (!turns) return false

    let aborted = false
    for (const turn of turns) {
      if (turn.ended) continue
      aborted = true
      turn.abortController.abort()
    }

    if (aborted) this.getAgent()?.abort()
    return aborted
  }

  private getReplayableTurn(userId: number): TurnState | null {
    const turns = this.liveTurns.get(userId)
    if (turns) {
      for (const turn of turns) {
        if (!turn.ended && turn.buffer.length > 0) return turn
      }
    }

    const recent = this.recentTurns.get(userId)
    if (!recent || recent.endedAt === null) return null
    if (Date.now() - recent.endedAt > this.completedTurnRetentionMs) {
      this.recentTurns.delete(userId)
      return null
    }
    return recent.buffer.length > 0 ? recent : null
  }

  private emit(turn: TurnState, event: TurnEvent): void {
    turn.buffer.push(event)
    const set = this.subscribers.get(turn.userId)
    if (!set) return
    for (const subscriber of [...set]) {
      try {
        subscriber(event)
      } catch (err) {
        console.error('[turn-runner] subscriber failed:', err)
      }
    }
  }

  private finishTurn(turn: TurnState): void {
    if (turn.ended) return
    turn.ended = true
    turn.endedAt = Date.now()

    const turns = this.liveTurns.get(turn.userId)
    if (turns) {
      turns.delete(turn)
      if (turns.size === 0) this.liveTurns.delete(turn.userId)
    }
    this.recentTurns.set(turn.userId, turn)

    this.emit(turn, { type: 'turn_end', turnId: turn.id })
    this.onTurnEnd?.(toInfo(turn))
  }

  private async runTurn(turn: TurnState, input: StartTurnInput): Promise<void> {
    if (turn.abortController.signal.aborted) {
      this.finishTurn(turn)
      return
    }

    const agent = this.getAgent()
    if (!agent) {
      this.emitChunk(turn, { type: 'error', error: 'Agent core not available' })
      this.emitChunk(turn, { type: 'done' })
      this.finishTurn(turn)
      return
    }

    this.onTurnStart?.(toInfo(turn))
    this.emit(turn, { type: 'turn_start', turnId: turn.id, sessionId: turn.sessionId })

    const transcript = new TurnTranscript(this.db, turn.sessionId, turn.userId)
    const watchdog = this.startStallWatchdog(turn, agent, this.resolveStallThresholds())
    let doneSent = false

    try {
      const stream = agent.sendMessage(
        String(turn.userId),
        input.text,
        input.source ?? 'web',
        input.attachments,
      )

      for await (const chunk of stream) {
        watchdog.recordActivity()
        if (turn.abortController.signal.aborted) break

        if (chunk.type === 'done') doneSent = true

        // Attachments are emitted before their tool chunk so consumers render
        // the download card on the running assistant turn, matching the order
        // used before the runner existed.
        for (const upload of transcript.record(chunk)) {
          this.emit(turn, { type: 'attachment', turnId: turn.id, attachment: upload })
        }

        this.emitChunk(turn, chunk)
      }

      transcript.finalize()
    } catch (err) {
      if (!turn.abortController.signal.aborted) {
        this.emitChunk(turn, { type: 'error', error: `Agent error: ${(err as Error).message}` })
      }
    } finally {
      watchdog.stop()
      // Flush any trailing thinking that wasn't closed by text/tool/done (e.g.
      // aborted/errored streams) so a reload shows the partial reasoning.
      transcript.flushThinking()
      // Always emit a 'done' if one wasn't already sent, so consumers never get
      // stuck with a streaming indicator that never resolves.
      if (!doneSent) this.emitChunk(turn, { type: 'done' })
      this.finishTurn(turn)
    }
  }

  private emitChunk(turn: TurnState, chunk: ResponseChunk): void {
    this.emit(turn, { type: 'chunk', turnId: turn.id, chunk })
  }

  /**
   * Thresholds are resolved per turn so a settings edit takes effect on the
   * next turn without a restart. Constructor options win over the config file.
   */
  private resolveStallThresholds(): StallThresholds {
    const fromSettings = loadStallThresholds()
    return {
      warnMs: this.stallWarnMs ?? fromSettings.warnMs,
      abortMs: this.stallAbortMs ?? fromSettings.abortMs,
    }
  }

  /**
   * Detects silently dead provider streams (e.g. zombie websocket-cached
   * sockets, halted SSE readers behind dropped HTTP/2 streams). Without this
   * the chunk loop blocks forever — pi-ai's parseSSE/parseWebSocket never throw
   * on idle, so no error reaches the runtime, no log line is written, and
   * consumers stay stuck on "streaming" without ever receiving a `done`.
   * Transport-agnostic: it sits one layer above SSE/WS so it covers both.
   *
   * Stalls surface as `stall_warning` / `stall_resolved` chunks (channel
   * agnostic) and as a single `provider_stall` chat row that is updated in
   * place on resolution — never deleted — so history keeps an honest record.
   */
  private startStallWatchdog(turn: TurnState, agent: TurnAgentLike, thresholds: StallThresholds) {
    let lastActivityAt = Date.now()
    let active: { startedAt: number; messageId: number | null } | null = null

    const persistStall = (stall: StallInfo): number | null => {
      try {
        return saveChatMessage(
          this.db,
          turn.sessionId,
          turn.userId,
          'system',
          formatProviderStallContent(stall),
          JSON.stringify(buildProviderStallMetadata(stall)),
        )
      } catch (err) {
        console.error('[turn-runner] Failed to persist stall warning:', err)
        return null
      }
    }

    const openStall = (now: number): void => {
      if (active) return
      const startedAt = lastActivityAt
      const stall: StallInfo = {
        startedAt: new Date(startedAt).toISOString(),
        durationMs: now - startedAt,
      }
      const messageId = persistStall(stall)
      active = { startedAt, messageId }
      console.warn(
        `[turn-runner] Provider slow: ${stall.durationMs}ms idle (user=${turn.userId}, `
        + `session=${turn.sessionId}).`,
      )
      this.emitChunk(turn, {
        type: 'stall_warning',
        // `text` mirrors the persisted row content so live rendering and a
        // history reload show the exact same wording.
        text: formatProviderStallContent(stall),
        stall: { ...stall, messageId: messageId ?? undefined },
      })
    }

    const closeStall = (now: number, outcome: StallOutcome): void => {
      if (!active) return
      const { startedAt, messageId } = active
      active = null

      const stall: StallInfo = {
        messageId: messageId ?? undefined,
        startedAt: new Date(startedAt).toISOString(),
        resolvedAt: new Date(now).toISOString(),
        durationMs: now - startedAt,
        outcome,
      }

      if (messageId !== null) {
        try {
          updateChatMessage(
            this.db,
            messageId,
            formatProviderStallContent(stall),
            JSON.stringify(buildProviderStallMetadata(stall)),
          )
        } catch (err) {
          console.error('[turn-runner] Failed to resolve stall warning:', err)
        }
      }

      this.emitChunk(turn, {
        type: 'stall_resolved',
        text: formatProviderStallContent(stall),
        stall,
      })
    }

    const timer = setInterval(() => {
      if (turn.abortController.signal.aborted) return
      const now = Date.now()
      const idleMs = now - lastActivityAt

      if (idleMs >= thresholds.abortMs) {
        console.error(
          `[turn-runner] Provider stalled ${idleMs}ms (user=${turn.userId}, `
          + `session=${turn.sessionId}). Aborting stream.`,
        )
        // A hard abort always leaves a stall row behind, even when the warn
        // threshold never fired (e.g. warn >= abort in a custom config).
        openStall(now)
        closeStall(now, 'aborted')
        this.emitChunk(turn, {
          type: 'error',
          error: `Provider stopped responding after ${Math.round(idleMs / 1000)}s. `
            + `Connection aborted — please retry.`,
        })
        turn.abortController.abort()
        // Propagate abort into pi-agent-core so the underlying SSE fetch /
        // WebSocket gets cancelled (mirrors the /stop command handler).
        agent.abort()
        return
      }

      if (idleMs >= thresholds.warnMs) openStall(now)
      // Never tick coarser than the warn threshold, otherwise a low threshold
      // would only fire on the next (much later) tick.
    }, Math.max(1, Math.min(this.watchdogIntervalMs, thresholds.warnMs)))

    return {
      recordActivity: () => {
        const now = Date.now()
        closeStall(now, 'recovered')
        lastActivityAt = now
      },
      /**
       * Called once the stream is over. A stall still open at that point never
       * recovered — the turn died while the provider was silent.
       */
      stop: () => {
        clearInterval(timer)
        closeStall(Date.now(), 'aborted')
      },
    }
  }
}

/**
 * Turns a chunk stream into `chat_messages` rows: thinking blocks, tool calls
 * and — once the stream ends — the assistant response with its attachments.
 * Rows are written as the turn progresses so a crashed process still leaves
 * the partial reasoning behind; the assistant row is deliberately written only
 * at the end, since its text is only complete then.
 */
class TurnTranscript {
  private fullResponse = ''
  private currentThinking = ''
  private readonly pendingToolCalls = new Map<string, { toolName: string; toolArgs: unknown }>()
  private readonly uploads: UploadDescriptor[] = []

  constructor(
    private readonly db: Database,
    private readonly sessionId: string,
    private readonly userId: number,
  ) {}

  /** Consume one chunk; returns any uploads the chunk produced. */
  record(chunk: ResponseChunk): UploadDescriptor[] {
    if (chunk.type === 'thinking' && chunk.thinking) {
      this.currentThinking += chunk.thinking
      return []
    }

    // Text, tool calls and the stream end all close an in-progress thinking run.
    this.flushThinking()

    if (chunk.type === 'text' && chunk.text) {
      this.fullResponse += chunk.text
      return []
    }

    if (chunk.type === 'tool_call_start' && chunk.toolCallId) {
      this.pendingToolCalls.set(chunk.toolCallId, {
        toolName: chunk.toolName ?? 'unknown',
        toolArgs: chunk.toolArgs,
      })
      return []
    }

    if (chunk.type === 'tool_call_end' && chunk.toolCallId) {
      const pending = this.pendingToolCalls.get(chunk.toolCallId)
      const toolName = pending?.toolName ?? chunk.toolName ?? 'unknown'
      saveChatMessage(this.db, this.sessionId, this.userId, 'tool', `Tool: ${toolName}`, JSON.stringify({
        toolName,
        toolCallId: chunk.toolCallId,
        toolArgs: pending?.toolArgs ?? null,
        toolResult: chunk.toolResult ?? null,
        toolIsError: chunk.toolIsError ?? false,
      }))
      this.pendingToolCalls.delete(chunk.toolCallId)

      const newUploads = extractUploadsFromToolResult(chunk.toolResult)
      this.uploads.push(...newUploads)
      return newUploads
    }

    return []
  }

  /**
   * Persist the buffered thinking run. The core runtime only surfaces
   * `thinking` deltas, so each contiguous run (uninterrupted by text/tool/done)
   * becomes its own row tagged `metadata.kind === 'thinking'`.
   */
  flushThinking(): void {
    if (!this.currentThinking) return
    const text = this.currentThinking
    this.currentThinking = ''
    try {
      saveChatMessage(this.db, this.sessionId, this.userId, 'assistant', text, JSON.stringify({ kind: 'thinking' }))
    } catch (err) {
      console.error('[turn-runner] Failed to persist thinking block:', err)
    }
  }

  /**
   * Write the assistant row. A turn that produced only attachments still gets
   * a row (with empty content) so the download card survives a history reload.
   */
  finalize(): void {
    if (!this.fullResponse && this.uploads.length === 0) return
    const metadata = this.uploads.length > 0 ? serializeUploadsMetadata(this.uploads) : undefined
    saveChatMessage(this.db, this.sessionId, this.userId, 'assistant', this.fullResponse, metadata)
  }
}

function toInfo(turn: TurnState): TurnInfo {
  return {
    turnId: turn.id,
    userId: turn.userId,
    sessionId: turn.sessionId,
    startedAt: turn.startedAt,
  }
}
