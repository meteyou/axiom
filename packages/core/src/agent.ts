import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import nodePath from 'node:path'
import type { Agent as PiAgent } from '@mariozechner/pi-agent-core'
import type { Api, ImageContent, Model } from '@mariozechner/pi-ai'
import { completeSimple } from '@mariozechner/pi-ai'
import type { Database } from './database.js'
import { getApiKeyForProvider, buildModel } from './provider-config.js'
import type { ProviderConfig } from './provider-config.js'
import type { ProviderManager } from './provider-manager.js'
import { loadConfig } from './config.js'
import { getUploadsDir } from './uploads.js'
import type { UploadDescriptor } from './uploads.js'
import { SessionManager } from './session-manager.js'
import type { SessionInfo } from './session-manager.js'
import { MessageQueue } from './message-queue.js'
import { createAgentRuntime } from './agent-runtime.js'
import type { AgentRuntimeBoundary, AgentRuntimePiAgentAccess } from './agent-runtime.js'
import type { AgentRuntimeStateSnapshot, ResponseChunk } from './agent-runtime-types.js'
import { resolveBackgroundReasoning } from './thinking-level.js'

export type { ResponseChunk } from './agent-runtime-types.js'
export { createYoloTools, isRetryablePreStreamError } from './agent-runtime.js'

export interface AgentCoreOptions {
  model: Model<Api>
  apiKey: string
  db: Database
  systemPrompt?: string
  tools?: import('@mariozechner/pi-agent-core').AgentTool[]
  memoryDir?: string
  sessionTimeoutMinutes?: number
  baseInstructions?: string
  providerConfig?: ProviderConfig // For OAuth token refresh
  providerManager?: ProviderManager // For fallback retry support
  /** Called when a session ends (timeout or /new command) with the summary text */
  onSessionEnd?: (userId: string, sessionId: string, summary: string | null) => void
}

// Re-export for backward compatibility
export { getWorkspaceDir } from './workspace.js'

/**
 * Agent Core - manages message queue/session lifecycle and delegates runtime internals
 * (tool wiring, prompt assembly, execution orchestration) to AgentRuntimeBoundary.
 */
export class AgentCore {
  private db: Database
  private sessionManager: SessionManager
  private memoryDir?: string
  private baseInstructions?: string
  private onSessionEndCallback?: (userId: string, sessionId: string, summary: string | null) => void
  private onTaskInjectionChunkCallback?: (chunk: ResponseChunk) => void
  private messageQueue: MessageQueue
  private currentToolUserId?: number
  private currentInteractiveSessionId?: string
  private runtime: AgentRuntimeBoundary

  constructor(options: AgentCoreOptions) {
    this.db = options.db
    this.memoryDir = options.memoryDir
    this.baseInstructions = options.baseInstructions
    this.onSessionEndCallback = options.onSessionEnd

    this.runtime = createAgentRuntime({
      model: options.model,
      apiKey: options.apiKey,
      db: options.db,
      systemPrompt: options.systemPrompt,
      tools: options.tools,
      memoryDir: options.memoryDir,
      baseInstructions: options.baseInstructions,
      providerConfig: options.providerConfig,
      providerManager: options.providerManager,
      getCurrentToolUserId: () => this.currentToolUserId,
    })

    // Initialize message queue for sequential processing
    this.messageQueue = new MessageQueue()

    // Initialize session manager
    this.sessionManager = new SessionManager({
      db: this.db,
      timeoutMinutes: options.sessionTimeoutMinutes ?? 15,
      memoryDir: options.memoryDir,
      onSummarize: async (_sessionId: string, userId: string, conversationHistory?: string) => {
        return this.generateSessionSummary(userId, conversationHistory)
      },
      onSessionEnd: (session: SessionInfo, summary: string | null) => {
        this.runtime.clearMessages()
        this.refreshSystemPrompt()

        // Notify external listener (e.g. ws-chat)
        if (this.onSessionEndCallback) {
          this.onSessionEndCallback(session.userId, session.id, summary)
        }
      },
    })
  }

  /**
   * Initialize async components (must be called after construction).
   * Handles orphaned sessions from previous server runs.
   */
  async init(): Promise<void> {
    await this.sessionManager.init()
  }

  /**
   * Get the session manager.
   */
  getSessionManager(): SessionManager {
    return this.sessionManager
  }

  /**
   * Hot-swap the provider at runtime while preserving conversation context.
   */
  swapProvider(provider: ProviderConfig, apiKey: string, modelId?: string): void {
    this.runtime.swapProvider(provider, apiKey, modelId)
  }

  /**
   * Get the ProviderManager reference (if configured).
   */
  getProviderManager(): ProviderManager | undefined {
    return this.runtime.getProviderManager()
  }

  /**
   * Send a message and get back an async iterable of response chunks.
   * All messages are queued and processed sequentially to prevent collisions.
   */
  async *sendMessage(userId: string, text: string, source: string = 'web', attachments?: UploadDescriptor[]): AsyncIterable<ResponseChunk> {
    const uploads = attachments
    const iterable = await this.messageQueue.enqueue<ResponseChunk>(
      'user_message',
      userId,
      text,
      source,
      (msg) => {
        return this.processUserMessage(msg.payload.userId, msg.payload.text, msg.payload.source, uploads)
      },
    )
    yield* iterable
  }

  /**
   * Inject a task result into the main agent via the message queue.
   * The injection is queued and processed sequentially like any other message.
   *
   * `targetUserId` identifies which user should see the task result.
   *
   * `forcedSessionId`, if provided, pins the injection to a specific session
   * ID regardless of SessionManager state. Callers use this to guarantee the
   * chunk stream's `sessionId` matches a pre-resolved id they can correlate
   * against — necessary because /new on another channel could otherwise
   * close the cached session between pre-resolution and the queued injection
   * actually running, producing a different sessionId in the chunk stream.
   * When omitted, the agent resolves a session the usual way (cached, last
   * known, or fresh interactive session).
   *
   * `injectionId`, if provided, is propagated onto every streamed chunk
   * (`chunk.injectionId`) so the caller can correlate chunks against a
   * per-injection metadata map without colliding with other injections
   * that happen to share the same target session id. When omitted a fresh
   * UUID is generated so every call still has a unique token.
   */
  async injectTaskResult(
    injection: string,
    targetUserId: string,
    forcedSessionId?: string,
    injectionId?: string,
  ): Promise<void> {
    const resolvedInjectionId = injectionId ?? randomUUID()
    const iterable = await this.messageQueue.enqueue<ResponseChunk>(
      'task_injection',
      targetUserId,
      injection,
      'task',
      (msg) => {
        return this.processTaskInjection(
          msg.payload.userId,
          msg.payload.text,
          forcedSessionId,
          resolvedInjectionId,
        )
      },
    )
    // Stream response chunks via callback (if set), otherwise drain silently
    for await (const chunk of iterable) {
      this.onTaskInjectionChunkCallback?.(chunk)
    }
  }

  /**
   * Process a user message (called from the queue).
   */
  private async *processUserMessage(userId: string, text: string, source: string, attachments?: UploadDescriptor[]): AsyncIterable<ResponseChunk> {
    const session = this.sessionManager.getOrCreateSession(userId, source)
    const sessionId = session.id
    this.currentInteractiveSessionId = sessionId

    // Resolve username for user profile injection (skip for group chats)
    let currentUser: { username: string } | undefined
    if (source !== 'telegram-group') {
      try {
        const row = this.db.prepare('SELECT username FROM users WHERE id = ?').get(userId) as { username: string } | undefined
        if (row?.username) {
          currentUser = { username: row.username }
        }
      } catch {
        // userId might not be a numeric ID (e.g. telegram-12345), skip
      }
    }

    // Pass channel as 'telegram' for both DM and group sources
    const channel = source.startsWith('telegram') ? 'telegram' : source
    this.refreshSystemPrompt(channel, currentUser)
    this.sessionManager.recordMessage(userId)

    // Build image content and file context from attachments
    const images: ImageContent[] = []
    const fileHints: string[] = []
    if (attachments?.length) {
      for (const att of attachments) {
        if (att.kind === 'image') {
          try {
            const absPath = nodePath.resolve(getUploadsDir(), att.relativePath)
            const buf = fs.readFileSync(absPath)
            images.push({ type: 'image', data: buf.toString('base64'), mimeType: att.mimeType })
          } catch {
            fileHints.push(`[Image upload failed to read: ${att.originalName}]`)
          }
        } else {
          const absPath = nodePath.resolve(getUploadsDir(), att.relativePath)
          fileHints.push(`[Uploaded file: ${att.originalName} (${att.mimeType}, ${att.size} bytes) at ${absPath}]`)
        }
      }
    }

    const enrichedText = fileHints.length > 0 ? `${text}\n\n${fileHints.join('\n')}` : text
    const parsedUserId = Number.parseInt(userId, 10)
    this.currentToolUserId = Number.isFinite(parsedUserId) ? parsedUserId : undefined

    try {
      yield* this.runtime.streamPrompt(enrichedText, sessionId, images.length > 0 ? images : undefined)
    } finally {
      this.currentToolUserId = undefined
      this.currentInteractiveSessionId = undefined
    }

    // Count the agent response as a message too
    this.sessionManager.recordMessage(userId)
  }

  /**
   * Returns the active interactive session ID for the user currently being
   * served (set during processUserMessage). Used by tools (e.g. create_task)
   * to link background sessions back to the triggering interactive session.
   */
  getCurrentInteractiveSessionId(): string | null {
    return this.currentInteractiveSessionId ?? null
  }

  /**
   * Process a task injection by sending it through the runtime boundary.
   *
   * The injection is logged under the target user's active interactive
   * session (or a new interactive session is created if none is active).
   * The response therefore appears inline in the user's conversation and
   * is naturally included in session summaries via
   * `buildConversationHistory()`.
   *
   * When `forcedSessionId` is provided, it is used unconditionally — this
   * lets callers correlate the chunk stream against a pre-resolved session
   * they have already recorded under a pending-injection map. The cached
   * SessionManager session (if any) still has its activity counter bumped
   * so the inactivity timer doesn't fire mid-injection.
   */
  private async *processTaskInjection(
    targetUserId: string,
    injection: string,
    forcedSessionId?: string,
    injectionId?: string,
  ): AsyncIterable<ResponseChunk> {
    // Resolve the session for this injection. Never create interactive
    // sessions with source='task' — this breaks source-based history /
    // usage filters. Resolution order:
    //   0. If a forced sessionId is provided (by the runtime composition
    //      after pre-resolution), use it verbatim.
    //   1. Active in-memory session (covers the common case).
    //   2. Most recent interactive session row for this user in the DB
    //      (covers users whose session cache expired).
    //   3. Smart default: 'telegram' if the user is linked to an approved
    //      Telegram account, otherwise 'web'. Prevents permanent source
    //      mistagging for Telegram-only users who had never started a
    //      session before the first task injection.
    let sessionId: string
    if (forcedSessionId) {
      sessionId = forcedSessionId
      // Still bump the cached session's activity counter if it matches,
      // so the inactivity timer doesn't fire while the injection runs.
      const cached = this.sessionManager.getSession(targetUserId)
      if (cached && cached.id === forcedSessionId) {
        this.sessionManager.recordMessage(targetUserId)
      }
    } else {
      const source = this.sessionManager.getSession(targetUserId)?.source
        ?? this.resolveLastInteractiveSource(targetUserId)
        ?? this.resolveDefaultInjectionSource(targetUserId)
      const session = this.sessionManager.getOrCreateSession(targetUserId, source)
      sessionId = session.id
      this.sessionManager.recordMessage(targetUserId)
    }
    this.currentInteractiveSessionId = sessionId

    const parsedUserId = Number.parseInt(targetUserId, 10)
    this.currentToolUserId = Number.isFinite(parsedUserId) ? parsedUserId : undefined

    try {
      for await (const chunk of this.runtime.streamPrompt(injection, sessionId)) {
        // Tag task-injection chunks with the actual session used AND the
        // per-injection correlation token. Downstream correlation MUST
        // key off `chunk.injectionId` (unique per call) and not
        // `chunk.sessionId` (shared across concurrent injections targeting
        // the same cached user session).
        yield { ...chunk, sessionId, injectionId }
      }
    } finally {
      this.currentToolUserId = undefined
      this.currentInteractiveSessionId = undefined
    }

    // Count the agent response as a message too (only when we're driving
    // the cached session — otherwise recordMessage is a no-op for users
    // without a cached session anyway).
    this.sessionManager.recordMessage(targetUserId)
  }

  /**
   * Pre-resolve the interactive session ID that a task-result injection for
   * `userId` will run under. Used by the runtime composition before calling
   * `injectTaskResult` so both the task-result `chat_messages` row and the
   * streamed injection response land in the same session.
   *
   * Resolution order (mirrors `processTaskInjection`):
   *   1. Active cached interactive session (hot user). Takes precedence
   *      UNCONDITIONALLY — a user actively chatting in a new session sees
   *      task results in that conversation, even if `fallbackSessionId`
   *      points at a different (older) session that triggered the task.
   *      This is intentional: surfacing results in the user's current
   *      conversation is more useful than threading them back into a
   *      session the user may have left behind.
   *   2. `fallbackSessionId` (e.g. the task's lineage parent from
   *      `resolveTaskNotificationSessionId`) — used only when no session
   *      is cached, so continuity with the triggering session is
   *      preserved without minting a new one.
   *   3. Create a fresh interactive session with a smart default source.
   *
   * The returned id is guaranteed to match the session AgentCore will use
   * when `injectTaskResult(..., forcedSessionId)` is invoked with it.
   */
  resolveInjectionSessionId(userId: string, fallbackSessionId?: string | null): string {
    const cached = this.sessionManager.getSession(userId)
    if (cached) return cached.id
    if (fallbackSessionId) return fallbackSessionId
    const source = this.resolveLastInteractiveSource(userId)
      ?? this.resolveDefaultInjectionSource(userId)
    return this.sessionManager.getOrCreateSession(userId, source).id
  }

  /**
   * Look up the user's most recent interactive session source in the
   * `sessions` table. Used when no session is cached in memory so a
   * Telegram-only user (or any user whose session cache expired) does not
   * get a new web-source session minted on task-result injection — which
   * would otherwise permanently mistag subsequent activity.
   */
  private resolveLastInteractiveSource(userId: string): string | null {
    const row = this.db.prepare(
      `SELECT source FROM sessions
       WHERE session_user = ? AND type = 'interactive'
       ORDER BY started_at DESC LIMIT 1`
    ).get(userId) as { source: string } | undefined
    return row?.source ?? null
  }

  /**
   * Default source for a brand-new interactive session when the user has
   * never had one before. Prefers 'telegram' when the user is linked to an
   * approved Telegram account so a task injection doesn't mint a 'web'
   * session for a Telegram-only user (which would otherwise mistag every
   * subsequent message on that channel).
   */
  private resolveDefaultInjectionSource(userId: string): string {
    const numericUserId = Number.parseInt(userId, 10)
    if (Number.isSafeInteger(numericUserId)) {
      try {
        const row = this.db.prepare(
          "SELECT 1 AS present FROM telegram_users WHERE user_id = ? AND status = 'approved' LIMIT 1",
        ).get(numericUserId) as { present: number } | undefined
        if (row) return 'telegram'
      } catch {
        // telegram_users table should always exist, but a missing/broken
        // schema must not block the injection — fall through to 'web'.
      }
    }
    return 'web'
  }

  /**
   * Handle /new command: summarize current session and start fresh.
   */
  async handleNewCommand(userId: string): Promise<string | null> {
    const summary = await this.sessionManager.handleNewCommand(userId)
    return summary
  }

  /**
   * Generate a summary of the current conversation using the LLM.
   * Returns a combined activity log entry that may include an optional
   * "### Offene Fäden" (open threads) section when unresolved items exist.
   */
  private async generateSessionSummary(_userId: string, conversationHistory?: string): Promise<string> {
    // Always use DB conversation history (single source of truth).
    // In-memory agent messages can disappear on provider change or restart,
    // but chat_messages in the DB are always reliable.
    if (!conversationHistory) {
      console.warn('[session-summary] No conversation history available, returning Empty session.')
      return 'Empty session.'
    }

    console.log(`[session-summary] Generating summary for ${conversationHistory.length} chars of history`)

    // Resolve model + apiKey: use dedicated summary provider if configured, else current model
    let summaryModel = this.runtime.getCurrentModel()
    let summaryApiKey = this.runtime.getCurrentApiKey()
    try {
      const summarySettings = loadConfig<{ sessionSummaryProviderId?: string }>('settings.json')
      const summaryProviderId = summarySettings.sessionSummaryProviderId
      if (summaryProviderId) {
        const { parseProviderModelId, loadProvidersDecrypted } = await import('./provider-config.js')
        const { providerId, modelId } = parseProviderModelId(summaryProviderId)
        if (providerId) {
          const file = loadProvidersDecrypted()
          const summaryProvider = file.providers.find(p => p.id === providerId)
          if (summaryProvider) {
            const resolvedModelId = modelId ?? summaryProvider.defaultModel
            summaryModel = buildModel(summaryProvider, resolvedModelId)
            summaryApiKey = await getApiKeyForProvider(summaryProvider)
            console.log(`[session-summary] Using dedicated provider: ${summaryProvider.name} (${resolvedModelId})`)
          } else {
            console.warn(`[session-summary] Configured summary provider '${providerId}' not found, using active provider`)
          }
        }
      }
    } catch {
      // Settings not available, use current model
    }

    try {
      // Session summary is a background job — use the background thinking level.
      const response = await completeSimple(summaryModel, {
        systemPrompt: `You are writing a chronological activity log entry for this session. Your output will be stored in a daily file so the agent can recall what happened in past sessions (e.g. "yesterday at 14:30 we discussed X and you asked me to do Y").

Your output has two parts:

**Part 1 — Activity Log (always required)**
- Write 2–5 sentences or bullet points. Max 200 words.
- Describe what actually happened: topics discussed, questions answered, decisions made, tasks started or completed, PRs or files created.
- If a background task completed or a task result was injected, mention its outcome (e.g. "PR #15 created for X", "wiki page updated").
- Use neutral, factual tone. No filler words. No meta-commentary about the summary itself.
- Do NOT filter for "memory-worthiness" — this is an activity log, not a memory promotion filter. Even a single answered question is worth one sentence.
- Write "Empty session." ONLY if the transcript contains nothing but greetings or a bare connection with zero substantive content.

**Part 2 — Open Threads (optional)**
If and only if there are genuinely unresolved items, append the following section after the activity log (separated by a blank line):

### Offene Fäden
- <concrete open item>
- <concrete open item>

Open items are: explicitly mentioned but unfinished tasks, background tasks started without a confirmed result, decisions that were deferred, or questions that were not answered.
Do NOT add this section if everything discussed was resolved or if there is nothing left open. Never add an empty "### Offene Fäden" section.`,
        messages: [{
          role: 'user' as const,
          content: `Analyze the following session transcript and write an activity log entry:\n\n<transcript>\n${conversationHistory}\n</transcript>`,
          timestamp: Date.now(),
        }],
      }, {
        apiKey: summaryApiKey,
        temperature: 0,
        reasoning: resolveBackgroundReasoning(),
      })

      const textContent = response.content.filter(c => c.type === 'text')

      if (textContent.length === 0) {
        console.warn('[session-summary] API response contained no text content. Full response.content:', JSON.stringify(response.content))
      }

      const summary = textContent
        .map(c => (c as { type: 'text'; text: string }).text)
        .join('')
        .trim()

      if (!summary) {
        console.warn('[session-summary] Summary was empty after filtering, falling back to "Empty session."')
      }

      return summary || 'Empty session.'
    } catch (err) {
      console.error('Failed to generate session summary:', err)
      return 'Session ended (summary generation failed).'
    }
  }

  /**
   * Set the callback for session end events.
   */
  setOnSessionEnd(callback: (userId: string, sessionId: string, summary: string | null) => void): void {
    this.onSessionEndCallback = callback
  }

  /**
   * Set a callback for response chunks generated when the agent processes a task injection.
   * This allows streaming the agent's natural-language response to connected clients.
   */
  setOnTaskInjectionChunk(callback: (chunk: ResponseChunk) => void): void {
    this.onTaskInjectionChunkCallback = callback
  }

  /**
   * Abort the current agent task.
   */
  abort(): void {
    this.runtime.abort()
  }

  /**
   * Reset a user's session (async - generates summary before reset).
   */
  async resetSession(userId: string): Promise<string | null> {
    const summary = await this.sessionManager.handleNewCommand(userId)
    return summary
  }

  /**
   * End all active sessions and emit session_end events.
   */
  async endAllSessions(): Promise<void> {
    await this.sessionManager.endAllSessions('provider_change')
  }

  /**
   * Refresh the system prompt from current memory state.
   */
  refreshSystemPrompt(channel?: string, currentUser?: { username: string }): void {
    this.runtime.refreshSystemPrompt(channel, currentUser)
  }

  /**
   * Update the thinking/reasoning level used for future agent turns.
   * Accepts any string; invalid values are ignored by the runtime.
   */
  setThinkingLevel(level: string): void {
    this.runtime.setThinkingLevel(level)
  }

  /**
   * Refresh skills: rebuild system prompt with current active skills.
   */
  refreshSkills(): void {
    this.refreshSystemPrompt()
  }

  /**
   * Get a stable runtime snapshot for diagnostics/testing.
   */
  getRuntimeStateSnapshot(): AgentRuntimeStateSnapshot {
    return this.runtime.getStateSnapshot()
  }

  /**
   * Get the message queue (for monitoring/testing).
   */
  getMessageQueue(): MessageQueue {
    return this.messageQueue
  }

  /**
   * Get the underlying pi-mono agent (for advanced usage).
   * @deprecated Prefer boundary methods like sendMessage()/abort()/getRuntimeStateSnapshot().
   */
  getAgent(): PiAgent {
    const runtimeWithAgent = this.runtime as Partial<AgentRuntimePiAgentAccess>
    if (typeof runtimeWithAgent.getAgent !== 'function') {
      throw new Error('Direct agent access is not available on this runtime implementation.')
    }

    return runtimeWithAgent.getAgent()
  }

  /**
   * Dispose all sessions and clean up.
   */
  async dispose(): Promise<void> {
    await this.sessionManager.dispose()
  }
}
