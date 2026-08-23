import { randomUUID } from 'node:crypto'
import type { Database } from './database.js'
import type {
  ResponseChunk,
  RetryInfo,
  StallInfo,
  StallOutcome,
  TurnErrorInfo,
} from './agent-runtime-types.js'
import { buildTurnErrorMetadata, formatTurnErrorContent } from './turn-error.js'
import { newTurnRetryActionId } from './turn-retry-action.js'
import type { UploadDescriptor } from './uploads.js'
import { serializeUploadsMetadata } from './uploads.js'
import { extractUploadsFromToolResult } from './send-file-tool.js'
import {
  buildProviderStallMetadata,
  formatProviderStallContent,
  loadStallThresholds,
} from './provider-stall.js'
import type { StallThresholds } from './provider-stall.js'
import {
  formatRetryScheduledContent,
  isRetryableTurnError,
  loadRetryPolicy,
  retryDelayMs,
} from './turn-retry.js'
import type { RetryPolicy } from './turn-retry.js'

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
  /**
   * Restart the failed assistant turn from the existing transcript instead of
   * re-sending the user message, so a retry never duplicates it in the model
   * context. Optional: agents without it are retried via `sendMessage`.
   */
  retryTurn?(
    userId: string,
    text: string,
    source?: string,
    attachments?: UploadDescriptor[],
  ): AsyncIterable<ResponseChunk>
  abort(): void
}

export interface TurnInfo {
  turnId: string
  /**
   * Identity handed to the agent and used to group turns/subscribers. For web
   * users this is the numeric user id as a string; an approved but unlinked
   * Telegram chat uses its `telegram-<id>` pseudo identity.
   */
  agentUserId: string
  /** `chat_messages.user_id`; null when the channel has no linked web user. */
  userId: number | null
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
  /**
   * Numeric user the persisted rows belong to. `null` for channels without a
   * linked web user (an approved but unassigned Telegram chat) — such turns
   * stream normally but persist nothing, matching pre-runner behavior.
   */
  userId: number | null
  /**
   * Agent-facing identity, also the subscription key. Defaults to
   * `String(userId)`, which is what the web chat uses; Telegram passes the
   * same value for linked users so both channels attach to the same turn.
   */
  agentUserId?: string
  sessionId: string
  text: string
  source?: string
  attachments?: UploadDescriptor[]
  /**
   * Restart a failed turn from the existing transcript instead of prompting
   * with `text` again (manual retry). Set via {@link TurnRunner.retryTurn}.
   */
  continueFromTranscript?: boolean
}

export interface TurnRunnerOptions {
  /**
   * Where turns are persisted. `null` disables persistence entirely (a channel
   * running without the web database); streaming, buffering and retry still
   * work unchanged.
   */
  db: Database | null
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
   * Auto-retry policy overrides. Fields set here win over `settings.json` →
   * `retry` (defaults: enabled, 3 retries, 2000 ms base delay).
   */
  retryPolicy?: Partial<RetryPolicy>
  /**
   * How long a finished turn stays replayable. Covers the "refresh right as
   * the answer completes" case: the client strips its trailing assistant/tool
   * messages and rebuilds them from the replay, so no duplicates appear.
   */
  completedTurnRetentionMs?: number
  onTurnStart?: (turn: TurnInfo) => void
  onTurnEnd?: (turn: TurnInfo) => void
  /**
   * Called once a turn ended terminally, after the `turn_error` row was
   * written. Channels use this to hang a manual-retry action off the error
   * (`error.retryActionId`).
   */
  onTurnFailed?: (failure: { turn: TurnInfo; error: TurnErrorInfo }) => void
}

interface TurnState {
  id: string
  /** Subscription/queue key — see {@link TurnInfo.agentUserId}. */
  key: string
  userId: number | null
  sessionId: string
  startedAt: number
  buffer: TurnEvent[]
  /** Turn-level abort: user initiated, never retried. */
  abortController: AbortController
  /** Per-attempt abort (watchdog stall): kills one attempt, not the turn. */
  attemptController: AbortController
  ended: boolean
  endedAt: number | null
}

/**
 * Result of one attempt at streaming the turn. `willRetry` is decided where
 * the attempt is run so the transcript rows of a doomed attempt are dropped
 * before the next one starts.
 */
type AttemptResult =
  | { status: 'completed' }
  | { status: 'aborted' }
  | { status: 'failed'; error: string; retryable: boolean; willRetry: boolean }

const DEFAULT_WATCHDOG_INTERVAL_MS = 5_000
const DEFAULT_COMPLETED_TURN_RETENTION_MS = 60_000

/**
 * Persist one row, or skip when the turn has no place to store it (no
 * database, or a channel without a linked web user).
 */
function saveChatMessage(
  db: Database | null,
  sessionId: string,
  userId: number | null,
  role: 'user' | 'assistant' | 'tool' | 'system',
  content: string,
  metadata?: string,
): number | null {
  if (!db || userId === null) return null
  const result = db.prepare(
    'INSERT INTO chat_messages (session_id, user_id, role, content, metadata) VALUES (?, ?, ?, ?, ?)'
  ).run(sessionId, userId, role, content, metadata ?? null)
  return Number(result.lastInsertRowid)
}

function updateChatMessage(db: Database, id: number, content: string, metadata: string): void {
  db.prepare('UPDATE chat_messages SET content = ?, metadata = ? WHERE id = ?').run(content, metadata, id)
}

/** Resolves `true` when the delay elapsed, `false` when `signal` aborted first. */
function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise<boolean>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer)
      resolve(false)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
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
  private readonly db: Database | null
  private readonly getAgent: () => TurnAgentLike | null
  private readonly stallWarnMs?: number
  private readonly stallAbortMs?: number
  private readonly watchdogIntervalMs: number
  private readonly retryPolicyOverrides?: Partial<RetryPolicy>
  private readonly completedTurnRetentionMs: number
  private readonly onTurnStart?: (turn: TurnInfo) => void
  private readonly onTurnEnd?: (turn: TurnInfo) => void
  private readonly onTurnFailed?: (failure: { turn: TurnInfo; error: TurnErrorInfo }) => void

  private readonly subscribers = new Map<string, Set<TurnSubscriber>>()
  /** Turns that are queued or streaming, per user. */
  private readonly liveTurns = new Map<string, Set<TurnState>>()
  /** Most recently finished turn per user, kept for the retention window. */
  private readonly recentTurns = new Map<string, TurnState>()
  /** Serializes turns per user so their chunk streams never interleave. */
  private readonly queues = new Map<string, Promise<void>>()

  constructor(options: TurnRunnerOptions) {
    this.db = options.db
    this.getAgent = options.getAgent
    this.stallWarnMs = options.stallWarnMs
    this.stallAbortMs = options.stallAbortMs
    this.watchdogIntervalMs = options.watchdogIntervalMs ?? DEFAULT_WATCHDOG_INTERVAL_MS
    this.retryPolicyOverrides = options.retryPolicy
    this.completedTurnRetentionMs = options.completedTurnRetentionMs ?? DEFAULT_COMPLETED_TURN_RETENTION_MS
    this.onTurnStart = options.onTurnStart
    this.onTurnEnd = options.onTurnEnd
    this.onTurnFailed = options.onTurnFailed
  }

  /**
   * Register a consumer for every turn of `userId`. If a turn is currently
   * running (or finished within the retention window) its buffered events are
   * replayed synchronously, flagged with `replay: true`, before any live event
   * is delivered.
   */
  // Consumed cross-workspace (web-backend, telegram); Fallow cannot resolve the
  // @axiom/core exports map, so it sees no caller outside this class.
  // fallow-ignore-next-line unused-class-member
  subscribe(user: number | string, subscriber: TurnSubscriber): () => void {
    const key = String(user)
    let set = this.subscribers.get(key)
    if (!set) {
      set = new Set()
      this.subscribers.set(key, set)
    }
    set.add(subscriber)

    const replayTarget = this.getReplayableTurn(key)
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
      const current = this.subscribers.get(key)
      if (!current) return
      current.delete(subscriber)
      if (current.size === 0) this.subscribers.delete(key)
    }
  }

  /** True while a turn for this user is queued or streaming. */
  // Called through the TurnRetryRunnerLike interface and cross-workspace; Fallow
  // attributes neither to this class.
  // fallow-ignore-next-line unused-class-member
  hasActiveTurn(user: number | string): boolean {
    const turns = this.liveTurns.get(String(user))
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
    const key = input.agentUserId ?? String(input.userId)
    const turn: TurnState = {
      id: randomUUID(),
      key,
      userId: input.userId,
      sessionId: input.sessionId,
      startedAt: Date.now(),
      buffer: [],
      abortController: new AbortController(),
      attemptController: new AbortController(),
      ended: false,
      endedAt: null,
    }

    let turns = this.liveTurns.get(key)
    if (!turns) {
      turns = new Set()
      this.liveTurns.set(key, turns)
    }
    turns.add(turn)

    const previous = this.queues.get(key) ?? Promise.resolve()
    const run = previous
      .catch(() => undefined)
      .then(() => this.runTurn(turn, input))
      .catch((err) => {
        console.error('[turn-runner] turn failed unexpectedly:', err)
      })
    this.queues.set(key, run)
    // Drop the drained chain so the map does not keep one entry per user that
    // ever chatted. A start that already read this promise stays chained to it.
    void run.then(() => {
      if (this.queues.get(key) === run) this.queues.delete(key)
    })

    return toInfo(turn)
  }

  /**
   * Re-run a failed turn (manual retry). Behaves like {@link startTurn} except
   * that the agent continues the existing transcript: the failed assistant
   * tail is dropped and the user message is never re-sent, so a retry cannot
   * duplicate it.
   */
  // Called through the TurnRetryRunnerLike interface and cross-workspace; Fallow
  // attributes neither to this class.
  // fallow-ignore-next-line unused-class-member
  retryTurn(input: StartTurnInput): TurnInfo {
    return this.startTurn({ ...input, continueFromTranscript: true })
  }

  /**
   * Abort every queued/streaming turn of a user (the `/stop` command, `/new`,
   * or an explicit kill). Returns true when something was actually aborted.
   */
  // Consumed cross-workspace (web-backend, telegram); Fallow cannot resolve the
  // @axiom/core exports map, so it sees no caller outside this class.
  // fallow-ignore-next-line unused-class-member
  abortTurn(user: number | string): boolean {
    const turns = this.liveTurns.get(String(user))
    if (!turns) return false

    let aborted = false
    for (const turn of turns) {
      if (turn.ended) continue
      aborted = true
      turn.abortController.abort()
      turn.attemptController.abort()
    }

    if (aborted) this.getAgent()?.abort()
    return aborted
  }

  private getReplayableTurn(key: string): TurnState | null {
    const turns = this.liveTurns.get(key)
    if (turns) {
      for (const turn of turns) {
        if (!turn.ended && turn.buffer.length > 0) return turn
      }
    }

    const recent = this.recentTurns.get(key)
    if (!recent || recent.endedAt === null) return null
    if (Date.now() - recent.endedAt > this.completedTurnRetentionMs) {
      this.recentTurns.delete(key)
      return null
    }
    return recent.buffer.length > 0 ? recent : null
  }

  private emit(turn: TurnState, event: TurnEvent): void {
    turn.buffer.push(event)
    const set = this.subscribers.get(turn.key)
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

    const turns = this.liveTurns.get(turn.key)
    if (turns) {
      turns.delete(turn)
      if (turns.size === 0) this.liveTurns.delete(turn.key)
    }
    this.recentTurns.set(turn.key, turn)
    this.scheduleRetentionSweep(turn)

    this.emit(turn, { type: 'turn_end', turnId: turn.id })
    this.onTurnEnd?.(toInfo(turn))
  }

  /**
   * Release the replay buffer once the turn is no longer replayable. Without
   * this the last turn of every user — including its tool results — would stay
   * resident for the lifetime of the process, since {@link getReplayableTurn}
   * only evicts on the next subscribe.
   */
  private scheduleRetentionSweep(turn: TurnState): void {
    const timer = setTimeout(() => {
      if (this.recentTurns.get(turn.key) === turn) this.recentTurns.delete(turn.key)
      turn.buffer = []
    }, this.completedTurnRetentionMs)
    timer.unref?.()
  }

  private async runTurn(turn: TurnState, input: StartTurnInput): Promise<void> {
    // Paired with `onTurnEnd` in `finishTurn` before any early exit: consumers
    // use the pair as a gauge (active requests), so an unmatched end would
    // decrement someone else's turn.
    this.onTurnStart?.(toInfo(turn))

    if (turn.abortController.signal.aborted) {
      this.finishTurn(turn)
      return
    }

    const agent = this.getAgent()
    if (!agent) {
      this.failTurn(turn, {
        cause: 'agent_unavailable',
        error: 'Agent core not available',
        attempts: 0,
        retryable: true,
      })
      this.emitChunk(turn, { type: 'done' })
      this.finishTurn(turn)
      return
    }

    this.emit(turn, { type: 'turn_start', turnId: turn.id, sessionId: turn.sessionId })

    const thresholds = this.resolveStallThresholds()
    const policy = this.resolveRetryPolicy()
    let attempt = 0

    for (;;) {
      const result = await this.runAttempt(turn, input, agent, thresholds, policy, attempt)
      if (result.status !== 'failed') break

      if (!result.willRetry) {
        this.failTurn(turn, {
          cause: result.retryable ? 'retry_exhausted' : 'non_retryable',
          error: result.error,
          attempts: attempt,
          retryable: result.retryable,
        })
        break
      }

      attempt++
      const retry: RetryInfo = {
        attempt,
        maxRetries: policy.maxRetries,
        delayMs: retryDelayMs(policy, attempt),
        error: result.error,
      }
      console.warn(
        `[turn-runner] Retryable provider error (user=${turn.userId}, session=${turn.sessionId}): `
        + `${result.error} — retry ${attempt}/${policy.maxRetries} in ${retry.delayMs}ms.`,
      )

      // The failed attempt is discarded, so drop its events from the replay
      // buffer too: a consumer attaching during the backoff must not rebuild
      // the partial answer that no longer exists in the transcript.
      turn.buffer = turn.buffer.filter(event => event.type === 'turn_start')
      this.emitChunk(turn, {
        type: 'retry_scheduled',
        text: formatRetryScheduledContent(retry),
        retry,
      })

      // A user abort during the backoff ends the turn like any other abort.
      if (!await sleepUnlessAborted(retry.delayMs, turn.abortController.signal)) break
    }

    // Exactly one `done` per turn, emitted after the last attempt, so consumers
    // never get stuck on a streaming indicator and never see a turn "end" twice.
    this.emitChunk(turn, { type: 'done' })
    this.finishTurn(turn)
  }

  /**
   * Stream one attempt of the turn. Returns how it ended; the caller decides
   * whether to restart. Nothing terminal (`error`, `done`) is emitted here —
   * a failed attempt that will be retried must leave no trace behind.
   */
  private async runAttempt(
    turn: TurnState,
    input: StartTurnInput,
    agent: TurnAgentLike,
    thresholds: StallThresholds,
    policy: RetryPolicy,
    attempt: number,
  ): Promise<AttemptResult> {
    turn.attemptController = new AbortController()
    const transcript = new TurnTranscript(this.db, turn.sessionId, turn.userId)
    const agentUserId = turn.key
    const stall: { error: string | null } = { error: null }
    const watchdog = this.startStallWatchdog(turn, agent, thresholds, (error) => { stall.error = error })
    let failure: { error: string; retryable: boolean } | null = null

    try {
      const continueTurn = attempt > 0 || input.continueFromTranscript === true
      const stream = continueTurn && agent.retryTurn
        ? agent.retryTurn(agentUserId, input.text, input.source ?? 'web', input.attachments)
        : agent.sendMessage(agentUserId, input.text, input.source ?? 'web', input.attachments)

      for await (const chunk of stream) {
        watchdog.recordActivity()
        if (this.isAttemptAborted(turn)) break

        // `done` is owned by the turn, not by an attempt.
        if (chunk.type === 'done') continue

        if (chunk.type === 'error') {
          const error = chunk.error ?? 'Unknown provider error'
          failure = { error, retryable: isRetryableTurnError(error) }
          break
        }

        // Attachments are emitted before their tool chunk so consumers render
        // the download card on the running assistant turn, matching the order
        // used before the runner existed.
        for (const upload of transcript.record(chunk)) {
          this.emit(turn, { type: 'attachment', turnId: turn.id, attachment: upload })
        }

        this.emitChunk(turn, chunk)
      }
    } catch (err) {
      if (!this.isAttemptAborted(turn)) {
        const message = (err as Error).message
        failure = { error: `Agent error: ${message}`, retryable: isRetryableTurnError(message) }
      }
    } finally {
      watchdog.stop()
    }

    // A watchdog kill outranks whatever the stream reported on its way out: it
    // is the reason the attempt died, and it is always retryable.
    if (stall.error) failure = { error: stall.error, retryable: true }

    // A user abort ends the turn even if the watchdog fired first: only the
    // watchdog's own kill counts as a retryable failure.
    if (turn.abortController.signal.aborted) {
      this.commitTranscript(transcript)
      return { status: 'aborted' }
    }

    if (!failure) {
      this.commitTranscript(transcript)
      return { status: 'completed' }
    }

    const willRetry = policy.enabled && attempt < policy.maxRetries && failure.retryable
    // Discarding keeps the transcript free of half-written answers from the
    // attempt that is about to be replaced; a terminal failure keeps whatever
    // the provider managed to produce.
    if (willRetry) transcript.discard()
    else this.commitTranscript(transcript)

    return { status: 'failed', error: failure.error, retryable: failure.retryable, willRetry }
  }

  /**
   * End the turn with a durable error row plus the matching `error` chunk.
   * Persisting is what turns the old "nothing happens" failure modes (expired
   * key, failed OAuth refresh, exhausted retries) into a message that is still
   * there after a reload; the chunk carries the same text and the row id so
   * live rendering and history agree.
   */
  private failTurn(turn: TurnState, failure: Omit<TurnErrorInfo, 'messageId' | 'occurredAt' | 'retryActionId'>): void {
    const info: TurnErrorInfo = {
      ...failure,
      occurredAt: new Date().toISOString(),
      retryActionId: newTurnRetryActionId(),
    }
    const content = formatTurnErrorContent(info)

    let messageId: number | null = null
    try {
      messageId = saveChatMessage(
        this.db,
        turn.sessionId,
        turn.userId,
        'system',
        content,
        JSON.stringify(buildTurnErrorMetadata(info)),
      )
    } catch (err) {
      console.error('[turn-runner] Failed to persist terminal error:', err)
      messageId = null
    }

    console.error(
      `[turn-runner] Turn failed (user=${turn.userId}, session=${turn.sessionId}, `
      + `cause=${info.cause}, attempts=${info.attempts}): ${info.error}`,
    )

    const errorInfo: TurnErrorInfo = { ...info, messageId: messageId ?? undefined }
    this.emitChunk(turn, {
      type: 'error',
      error: info.error,
      text: content,
      errorInfo,
    })

    // Only a persisted error can carry a retry button: the action is resolved
    // against the row id, and without it a reload would lose the button.
    if (messageId !== null) this.onTurnFailed?.({ turn: toInfo(turn), error: errorInfo })
  }

  /**
   * Flush any trailing thinking that wasn't closed by text/tool/done (e.g.
   * aborted/errored streams) and write the assistant row.
   */
  private commitTranscript(transcript: TurnTranscript): void {
    transcript.flushThinking()
    transcript.finalize()
  }

  private isAttemptAborted(turn: TurnState): boolean {
    return turn.abortController.signal.aborted || turn.attemptController.signal.aborted
  }

  private emitChunk(turn: TurnState, chunk: ResponseChunk): void {
    this.emit(turn, { type: 'chunk', turnId: turn.id, chunk })
  }

  /**
   * Resolved per turn so a settings edit applies to the next turn without a
   * restart. Constructor overrides win over the config file.
   */
  private resolveRetryPolicy(): RetryPolicy {
    return { ...loadRetryPolicy(), ...this.retryPolicyOverrides }
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
   *
   * A hard abort is reported through `onAbort` instead of erroring out
   * directly: unlike a user abort it counts as a retryable failure, so the
   * attempt loop decides whether the turn restarts or ends.
   */
  private startStallWatchdog(
    turn: TurnState,
    agent: TurnAgentLike,
    thresholds: StallThresholds,
    onAbort: (error: string) => void,
  ) {
    let lastActivityAt = Date.now()
    let active: { startedAt: number; messageId: number | null } | null = null

    const db = this.db

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

      if (messageId !== null && db) {
        try {
          updateChatMessage(
            db,
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
      if (this.isAttemptAborted(turn)) return
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
        onAbort(
          `Provider stopped responding after ${Math.round(idleMs / 1000)}s. `
          + `Connection aborted — please retry.`,
        )
        turn.attemptController.abort()
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
  /** Rows written so far, so a discarded attempt can roll them back. */
  private readonly writtenRowIds: number[] = []

  constructor(
    private readonly db: Database | null,
    private readonly sessionId: string,
    private readonly userId: number | null,
  ) {}

  private get persists(): boolean {
    return this.db !== null && this.userId !== null
  }

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
      this.remember(saveChatMessage(this.db, this.sessionId, this.userId, 'tool', `Tool: ${toolName}`, JSON.stringify({
        toolName,
        toolCallId: chunk.toolCallId,
        toolArgs: pending?.toolArgs ?? null,
        toolResult: chunk.toolResult ?? null,
        toolIsError: chunk.toolIsError ?? false,
      })))
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
      this.remember(
        saveChatMessage(this.db, this.sessionId, this.userId, 'assistant', text, JSON.stringify({ kind: 'thinking' })),
      )
    } catch (err) {
      console.error('[turn-runner] Failed to persist thinking block:', err)
    }
  }

  private remember(rowId: number | null): void {
    if (rowId !== null) this.writtenRowIds.push(rowId)
  }

  /**
   * Roll back everything this attempt wrote. Used when a retryable error kills
   * the attempt: the restarted turn produces its own thinking and tool rows,
   * and leaving the failed ones behind would duplicate them in the history.
   * Stall notices are written by the watchdog, not here, so they survive —
   * they are an honest record of what happened.
   */
  discard(): void {
    this.fullResponse = ''
    this.currentThinking = ''
    this.pendingToolCalls.clear()
    this.uploads.length = 0
    if (!this.db || this.writtenRowIds.length === 0) return
    try {
      const statement = this.db.prepare('DELETE FROM chat_messages WHERE id = ?')
      for (const id of this.writtenRowIds) statement.run(id)
    } catch (err) {
      console.error('[turn-runner] Failed to discard the failed attempt:', err)
    }
    this.writtenRowIds.length = 0
  }

  /**
   * Write the assistant row. A turn that produced only attachments still gets
   * a row (with empty content) so the download card survives a history reload.
   */
  finalize(): void {
    if (!this.persists) return
    if (!this.fullResponse && this.uploads.length === 0) return
    const metadata = this.uploads.length > 0 ? serializeUploadsMetadata(this.uploads) : undefined
    this.remember(
      saveChatMessage(this.db, this.sessionId, this.userId, 'assistant', this.fullResponse, metadata),
    )
  }
}

function toInfo(turn: TurnState): TurnInfo {
  return {
    turnId: turn.id,
    agentUserId: turn.key,
    userId: turn.userId,
    sessionId: turn.sessionId,
    startedAt: turn.startedAt,
  }
}
