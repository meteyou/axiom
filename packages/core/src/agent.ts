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
        // Only clear agent messages for non-system sessions.
        // System sessions (from task injections) share the same agent instance,
        // and clearing messages here would wipe the user's conversation history
        // before their session has a chance to generate a summary.
        if (session.userId !== 'system') {
          this.runtime.clearMessages()
          this.refreshSystemPrompt()
        }

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
   */
  async injectTaskResult(injection: string): Promise<void> {
    const iterable = await this.messageQueue.enqueue<ResponseChunk>(
      'task_injection',
      'system',
      injection,
      'task',
      (msg) => {
        return this.processTaskInjection(msg.payload.text)
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
   */
  private async *processTaskInjection(injection: string): AsyncIterable<ResponseChunk> {
    const session = this.sessionManager.getOrCreateSession('system', 'task')
    const sessionId = session.id

    this.sessionManager.recordMessage('system')
    this.currentToolUserId = undefined

    try {
      yield* this.runtime.streamPrompt(injection, sessionId)
    } finally {
      this.currentToolUserId = undefined
    }

    // Count the agent response as a message too
    this.sessionManager.recordMessage('system')
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
