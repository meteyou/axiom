import { randomUUID } from 'node:crypto'
import type { Agent as PiAgent, AgentLoopTurnUpdate, AgentMessage, PrepareNextTurnContext } from '@earendil-works/pi-agent-core'
import { isContextOverflow } from '@earendil-works/pi-ai'
import type { Api, AssistantMessage, Model, RetryPolicy } from '@earendil-works/pi-ai'
import type { Database } from './database.js'
import type { ContextCompactionInfo, ContextCompactionWarning } from './contracts/compaction.js'
import type { ModelCompactionOverrideContract } from './contracts/providers.js'
import {
  CompactionAbortedError,
  checkCompactionInvariant,
  compactMessages,
  estimateContextTokens,
  estimateMessageTokens,
  findSummaryMessage,
  projectCompactedTokens,
  resolveCompactionSettings,
  resolveEffectiveCompactionBudget,
  shouldCompact,
} from './compaction.js'
import type {
  CompactionOutcome,
  CompactionReason,
  CompactionScope,
  CompactionSettingsSource,
  EffectiveCompactionBudget,
  ResolvedCompactionSettings,
} from './compaction.js'
import { saveContextCompaction } from './compaction-store.js'
import { loadCompactionSettings } from './compaction-diagnostics.js'
import { estimateCost } from './provider-config.js'
import { logTokenUsage } from './token-logger.js'
import type { TokenUsageRecord } from './token-logger.js'
import { CONTEXT_OVERFLOW_ERROR_PREFIX } from './turn-retry.js'

const DEFAULT_KEEPALIVE_MS = 10_000
/**
 * The `running` keepalives hold off the turn's stall watchdog, so a hung
 * summary call needs its own limit. Generous because the summary prompt is
 * never prefix-cached and slow local models need a long prefill.
 */
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000

export type CompactionUsage = Pick<TokenUsageRecord, 'promptTokens' | 'completionTokens' | 'cacheRead' | 'cacheWrite' | 'estimatedCost'>

export interface ContextCompactorOptions {
  scope: CompactionScope
  /** Where compaction records and summary token usage are written; omit to skip persistence. */
  db?: Database | null
  getSessionId: () => string | undefined
  resolveApiKey: () => Promise<string | undefined> | string | undefined
  getModelOverride?: (model: Model<Api>) => ModelCompactionOverrideContract | undefined
  loadSettings?: () => CompactionSettingsSource | undefined
  /** Lifecycle of every compaction: `running` (repeated as keepalive), then one terminal status. */
  onEvent?: (info: ContextCompactionInfo) => void
  /** Token usage of every successful compaction, e.g. for per-task cost totals. */
  onUsage?: (usage: CompactionUsage) => void
  retryPolicy?: () => RetryPolicy | undefined
  keepaliveMs?: number
  /** Abort the summary call when the provider shows no sign of life for this long. */
  idleTimeoutMs?: number
  now?: () => number
}

export interface CompactNowOptions {
  reason: CompactionReason
  instructions?: string
  signal?: AbortSignal
}

function lastAssistant(messages: readonly AgentMessage[]): AssistantMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role === 'assistant') return message
  }
  return null
}

/**
 * The transcript without the assistant messages a failed turn left at its
 * end, or null when what remains does not end on a message the model still
 * owes an answer to (then the turn cannot be continued).
 */
export function withoutFailedAssistantTail(messages: readonly AgentMessage[]): AgentMessage[] | null {
  let end = messages.length
  while (end > 0 && messages[end - 1].role === 'assistant') end--
  if (end === 0) return null
  const last = messages[end - 1]
  if (last.role !== 'user' && last.role !== 'toolResult') return null
  return messages.slice(0, end)
}

/** Error text for an overflow the runtime gave up on; classified as `context_overflow`. */
export function describeContextOverflow(model: Model<Api>, message: AssistantMessage, cause: string): string {
  const original = message.errorMessage || `stopped (${message.stopReason}) before producing output`
  return `${CONTEXT_OVERFLOW_ERROR_PREFIX}${model.id}, ${model.contextWindow} tokens) and ${cause}: ${original}`
}

function linkSignals(signals: (AbortSignal | undefined)[]): AbortController {
  const controller = new AbortController()
  for (const signal of signals) {
    if (!signal) continue
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', () => controller.abort(), { once: true })
  }
  return controller
}

/**
 * Owns context compaction for one pi agent: the between-turn hook, the check
 * before a new prompt, overflow recovery and manual `/compact`. Both the main
 * chat runtime and task agents attach one through `createAxiomAgent`, so the
 * two paths cannot drift apart.
 */
export class ContextCompactor {
  private agent: PiAgent | null = null
  private activeAbort: AbortController | null = null
  /**
   * Last assistant message present when the previous compaction ran. A new
   * compaction needs a newer one, i.e. at most one compaction per turn.
   */
  private lastCompactionAnchor: AssistantMessage | null | undefined = undefined
  /**
   * Summary size of the last compaction that could not get the context below
   * the trigger, while automatic compaction is paused because of it.
   */
  private pausedSummaryTokens: number | null = null
  private warned = new Set<ContextCompactionWarning>()

  constructor(private readonly options: ContextCompactorOptions) {}

  // Called by createAxiomAgent, which only holds a type import of this class.
  // fallow-ignore-next-line unused-class-member
  attach(agent: PiAgent): void {
    this.agent = agent
    agent.prepareNextTurnWithContext = (turn, signal) => this.prepareNextTurn(turn, signal)
  }

  /** Forget per-conversation state (new session, cleared transcript). */
  reset(): void {
    this.lastCompactionAnchor = undefined
    this.pausedSummaryTokens = null
    this.warned.clear()
  }

  abort(): void {
    this.activeAbort?.abort()
  }

  resolveSettings(model: Model<Api>): ResolvedCompactionSettings {
    const settings = (this.options.loadSettings ?? loadCompactionSettings)()
    return resolveCompactionSettings(this.options.scope, settings, this.options.getModelOverride?.(model))
  }

  resolveBudget(model: Model<Api>): { settings: ResolvedCompactionSettings; budget: EffectiveCompactionBudget } {
    const settings = this.resolveSettings(model)
    return { settings, budget: resolveEffectiveCompactionBudget(settings, model.contextWindow) }
  }

  /**
   * Overflow the transcript cannot recover from by itself: an explicit
   * provider context-overflow error, or a length stop that ended before any
   * visible output because the window was nearly full.
   */
  isRecoverableOverflow(message: AssistantMessage): boolean {
    // A silent overflow still produced an answer; only failed turns are retried.
    if (message.stopReason !== 'error' && message.stopReason !== 'length') return false
    const model = this.requireAgent().state.model
    if (isContextOverflow(message, model.contextWindow)) return true
    if (message.stopReason !== 'length') return false
    const producedOutput = message.content.some(block =>
      (block.type === 'text' && block.text.trim() !== '') || block.type === 'toolCall')
    return !producedOutput && message.usage.output < model.maxTokens
  }

  async prepareNextTurn(turn: PrepareNextTurnContext, signal?: AbortSignal): Promise<AgentLoopTurnUpdate | undefined> {
    const outcome = await this.compactIfNeeded(turn.context.messages, 0, signal)
    if (!outcome) return undefined
    return { context: { ...turn.context, messages: outcome.messages.slice() } }
  }

  /**
   * Check before a new prompt (or a continuation) starts. `pendingTokens`
   * accounts for the prompt that is about to be added.
   */
  async compactBeforePrompt(pendingTokens = 0, signal?: AbortSignal): Promise<CompactionOutcome | null> {
    return this.compactIfNeeded(this.requireAgent().state.messages, pendingTokens, signal)
  }

  /**
   * Compact the transcript without the failed turn, leaving it ready for
   * `agent.continue()`. Returns false when the turn cannot be recovered.
   */
  async recoverFromOverflow(signal?: AbortSignal): Promise<boolean> {
    const agent = this.requireAgent()
    if (!this.resolveSettings(agent.state.model).enabled) return false
    const continuable = withoutFailedAssistantTail(agent.state.messages)
    if (!continuable) return false
    // The failed turn stays in the transcript unless compaction succeeds, so
    // callers can still report what the provider said.
    return (await this.run(continuable, { reason: 'overflow', signal })) !== null
  }

  /** Manual compaction; runs even when automatic compaction is disabled. */
  async compactNow(options: CompactNowOptions): Promise<CompactionOutcome | null> {
    return this.run(this.requireAgent().state.messages, options)
  }

  private async compactIfNeeded(
    messages: AgentMessage[],
    pendingTokens: number,
    signal?: AbortSignal,
  ): Promise<CompactionOutcome | null> {
    const model = this.requireAgent().state.model
    // Without a known window there is no threshold to compare against.
    if (!model || !(model.contextWindow > 0)) return null
    const { settings, budget } = this.resolveBudget(model)
    if (!settings.enabled) return null
    if (this.lastCompactionAnchor !== undefined && this.lastCompactionAnchor === lastAssistant(messages)) return null
    const tokens = estimateContextTokens(messages).tokens + pendingTokens
    if (!shouldCompact(tokens, budget) || !this.isWorthCompacting(messages, pendingTokens, budget)) return null
    return this.run(messages, { reason: 'threshold', signal })
  }

  /**
   * Skips summary calls that cannot help: nothing old enough to summarize, or,
   * after an attempt that stayed above the trigger, a projection with that
   * attempt's summary size still above it. A window too small for system
   * prompt + summary then costs no call per turn, while a huge kept message
   * stops blocking as soon as newer messages let the cut move past it.
   */
  private isWorthCompacting(
    messages: readonly AgentMessage[],
    pendingTokens: number,
    budget: EffectiveCompactionBudget,
  ): boolean {
    const projected = projectCompactedTokens(messages, budget.keepRecentTokens, this.pausedSummaryTokens ?? 0)
    if (projected === null) return false
    return this.pausedSummaryTokens === null || projected + pendingTokens <= budget.triggerTokens
  }

  private async run(messages: AgentMessage[], options: CompactNowOptions): Promise<CompactionOutcome | null> {
    const agent = this.requireAgent()
    const model = agent.state.model
    const { budget } = this.resolveBudget(model)
    const now = this.options.now ?? Date.now
    const compactionId = randomUUID()
    const tokensBefore = estimateContextTokens(messages).tokens
    const base = { compactionId, reason: options.reason, tokensBefore }
    const emit = (info: Omit<ContextCompactionInfo, 'compactionId' | 'reason' | 'tokensBefore' | 'occurredAt'>) =>
      this.options.onEvent?.({ ...base, ...info, occurredAt: new Date(now()).toISOString() })

    const controller = linkSignals([options.signal])
    this.activeAbort = controller
    const idleTimeoutMs = this.options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
    let lastProgressAt = Date.now()
    let timedOut = false
    emit({ status: 'running' })
    const keepalive = setInterval(() => {
      if (Date.now() - lastProgressAt < idleTimeoutMs) {
        emit({ status: 'running' })
        return
      }
      timedOut = true
      controller.abort()
    }, Math.min(this.options.keepaliveMs ?? DEFAULT_KEEPALIVE_MS, idleTimeoutMs))
    keepalive.unref?.()

    try {
      const outcome = await compactMessages(messages, {
        budget,
        model,
        apiKey: await this.options.resolveApiKey(),
        streamFn: agent.streamFunction,
        signal: controller.signal,
        sessionId: this.options.getSessionId(),
        customInstructions: options.instructions,
        retryPolicy: this.options.retryPolicy?.(),
        onProgress: () => { lastProgressAt = Date.now() },
        now,
      })
      if (!outcome) {
        emit({ status: 'skipped', error: 'Nothing to compact yet.' })
        return null
      }

      agent.state.messages = outcome.messages
      this.lastCompactionAnchor = lastAssistant(outcome.messages)
      this.recordUsage(outcome, options.reason, model)
      const warnings = this.checkHeadroom(outcome, budget, messages)
      emit({
        status: 'completed',
        tokensAfter: outcome.tokensAfter,
        summary: outcome.summary,
        ...(warnings.length > 0 ? { warnings } : {}),
      })
      return outcome
    } catch (err) {
      const aborted = err instanceof CompactionAbortedError || controller.signal.aborted
      const message = timedOut
        ? `Compaction timed out: no response from the provider for ${Math.round(idleTimeoutMs / 1000)}s`
        : aborted ? 'Compaction aborted' : (err instanceof Error ? err.message : String(err))
      if (timedOut || !aborted) console.warn(`[compaction] ${this.options.scope} compaction failed:`, message)
      emit({ status: 'failed', error: message })
      return null
    } finally {
      clearInterval(keepalive)
      if (this.activeAbort === controller) this.activeAbort = null
    }
  }

  /** Warnings worth showing with this compaction; each is reported once per conversation. */
  private checkHeadroom(
    outcome: CompactionOutcome,
    budget: EffectiveCompactionBudget,
    before: AgentMessage[],
  ): ContextCompactionWarning[] {
    const warnings: ContextCompactionWarning[] = []
    const systemPromptTokens = before[0]?.role === 'system' ? estimateMessageTokens(before[0]) : 0
    const invariant = checkCompactionInvariant(budget, systemPromptTokens)
    if (!invariant.ok && this.warnOnce('window_too_small', `Context window of ${budget.contextWindow} tokens is too small `
      + `for the system prompt plus compaction summary and kept tail (${invariant.requiredTokens} > `
      + `${invariant.budgetTokens} tokens). Compaction will keep re-triggering.`)) {
      warnings.push('window_too_small')
    }
    if (outcome.tokensAfter > budget.triggerTokens) {
      const summary = findSummaryMessage(outcome.messages)
      this.pausedSummaryTokens = summary ? estimateMessageTokens(summary.message) : 0
      if (this.warnOnce('auto_paused', `Compaction could not bring the context below ${budget.triggerTokens} tokens `
        + `(${outcome.tokensAfter} after compaction); automatic compaction is paused until it can.`)) {
        warnings.push('auto_paused')
      }
    } else {
      this.pausedSummaryTokens = null
      this.warned.delete('auto_paused')
    }
    return warnings
  }

  /** Logs the warning and returns true the first time `key` is raised. */
  private warnOnce(key: ContextCompactionWarning, message: string): boolean {
    if (this.warned.has(key)) return false
    this.warned.add(key)
    console.warn(`[compaction] ${message}`)
    return true
  }

  private recordUsage(outcome: CompactionOutcome, reason: CompactionReason, model: Model<Api>): void {
    const usage = outcome.usage
    const tokens: CompactionUsage = {
      promptTokens: usage.input,
      completionTokens: usage.output,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      estimatedCost: usage.cost.total > 0
        ? usage.cost.total
        : estimateCost(model, usage.input, usage.output, usage.cacheRead, usage.cacheWrite),
    }
    this.options.onUsage?.(tokens)

    const db = this.options.db
    if (!db) return
    const sessionId = this.options.getSessionId() ?? null
    try {
      saveContextCompaction(db, {
        sessionId,
        scope: this.options.scope,
        reason,
        provider: model.provider,
        model: model.id,
        tokensBefore: outcome.tokensBefore,
        tokensAfter: outcome.tokensAfter,
        summary: outcome.summary,
        firstKeptTimestamp: outcome.firstKeptTimestamp,
        ...tokens,
      })
      logTokenUsage(db, { provider: model.provider, model: model.id, ...tokens, sessionId: sessionId ?? undefined })
    } catch (err) {
      console.error('[compaction] Failed to persist compaction record:', err)
    }
  }

  private requireAgent(): PiAgent {
    if (!this.agent) throw new Error('ContextCompactor is not attached to an agent')
    return this.agent
  }
}
