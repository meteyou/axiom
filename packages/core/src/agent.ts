import { execSync } from 'node:child_process'
import fs from 'node:fs'
import nodePath from 'node:path'
import { Agent as PiAgent } from '@mariozechner/pi-agent-core'
import type { AgentEvent, AgentTool } from '@mariozechner/pi-agent-core'
import type { Api, AssistantMessage, ImageContent, Message, Model } from '@mariozechner/pi-ai'
import { Type, completeSimple } from '@mariozechner/pi-ai'
import type { Database } from './database.js'
import { logTokenUsage, logToolCall } from './token-logger.js'
import { estimateCost, getApiKeyForProvider, buildModel } from './provider-config.js'
import type { ProviderConfig } from './provider-config.js'
import type { ProviderManager } from './provider-manager.js'
import { assembleSystemPrompt, ensureMemoryStructure } from './memory.js'
import type { SkillPromptEntry } from './memory.js'
import { loadConfig, ensureConfigTemplates } from './config.js'
import { loadSkills, getSkillDecrypted } from './skill-config.js'
import { getUploadsDir } from './uploads.js'
import type { UploadDescriptor } from './uploads.js'
import { createMemoryTools } from './memory-tools.js'
import { createBuiltinWebTools } from './web-tools.js'
import type { BuiltinToolsConfig } from './web-tools.js'
import { SessionManager } from './session-manager.js'
import type { SessionInfo } from './session-manager.js'
import { MessageQueue } from './message-queue.js'

/**
 * A chunk yielded from the agent's response stream
 */
export interface ResponseChunk {
  type: 'text' | 'tool_call_start' | 'tool_call_end' | 'error' | 'done'
  text?: string
  toolName?: string
  toolCallId?: string
  toolArgs?: unknown
  toolResult?: unknown
  toolIsError?: boolean
  error?: string
}

export interface AgentCoreOptions {
  model: Model<Api>
  apiKey: string
  db: Database
  systemPrompt?: string
  tools?: AgentTool[]
  yoloMode?: boolean
  memoryDir?: string
  sessionTimeoutMinutes?: number
  baseInstructions?: string
  providerConfig?: ProviderConfig // For OAuth token refresh
  providerManager?: ProviderManager // For fallback retry support
  /** Called when a session ends (timeout or /new command) with the summary text */
  onSessionEnd?: (userId: string, summary: string | null) => void
}

/**
 * Get the workspace directory for agent file operations.
 * Falls back to DATA_DIR/workspace, then /workspace (Docker default).
 */
export function getWorkspaceDir(): string {
  if (process.env.WORKSPACE_DIR) return process.env.WORKSPACE_DIR
  if (process.env.DATA_DIR) {
    const wsDir = nodePath.join(process.env.DATA_DIR, 'workspace')
    if (!fs.existsSync(wsDir)) fs.mkdirSync(wsDir, { recursive: true })
    return wsDir
  }
  return '/workspace'
}

/**
 * Resolve a path relative to WORKSPACE_DIR (consistent across all tools)
 */
function resolveWorkspacePath(filePath: string): string {
  if (nodePath.isAbsolute(filePath)) return filePath
  return nodePath.resolve(getWorkspaceDir(), filePath)
}

/**
 * Build YOLO-mode tools that give the agent unrestricted access
 */
export function createYoloTools(): AgentTool[] {
  const shellTool: AgentTool = {
    name: 'shell',
    label: 'Execute Shell Command',
    description: 'Execute a shell command and return stdout/stderr. Use this for any system operation. You run as a non-root user; use sudo for privileged operations (e.g. sudo apt-get install, sudo systemctl).',
    parameters: Type.Object({
      command: Type.String({ description: 'The shell command to execute' }),
      timeout: Type.Optional(Type.Number({ description: 'Timeout in milliseconds (default: 60000)' })),
    }),
    execute: async (_toolCallId, params) => {
      const { command, timeout = 60000 } = params as { command: string; timeout?: number }
      try {
        const result = execSync(command, {
          timeout,
          encoding: 'utf-8',
          maxBuffer: 10 * 1024 * 1024,
          cwd: getWorkspaceDir(),
        })
        return {
          content: [{ type: 'text' as const, text: result || '(no output)' }],
          details: { exitCode: 0 },
        }
      } catch (err: unknown) {
        const error = err as { stdout?: string; stderr?: string; status?: number; message?: string }
        const output = [error.stdout, error.stderr].filter(Boolean).join('\n') || error.message || 'Command failed'
        return {
          content: [{ type: 'text' as const, text: output }],
          details: { exitCode: error.status ?? 1 },
        }
      }
    },
  }

  const readFileTool: AgentTool = {
    name: 'read_file',
    label: 'Read File',
    description: 'Read the contents of a file at the given path.',
    parameters: Type.Object({
      path: Type.String({ description: 'Path to the file to read' }),
    }),
    execute: async (_toolCallId, params) => {
      const { path: filePath } = params as { path: string }
      try {
        const resolved = resolveWorkspacePath(filePath)
        let content = fs.readFileSync(resolved, 'utf-8')

        // Detect SKILL.md loads under /data/skills/
        const skillMdMatch = resolved.match(/\/data\/skills\/(.+)\/SKILL\.md$/)
        if (skillMdMatch) {
          const skillDir = nodePath.dirname(resolved)

          // Replace {baseDir} with actual skill directory
          content = content.replaceAll('{baseDir}', skillDir)

          // Look up skill in skills.json and inject env vars
          const injectedVars: string[] = []
          try {
            const skillsFile = loadSkills()
            const matchedSkill = skillsFile.skills.find(s => resolved.startsWith(s.path))
            if (matchedSkill) {
              const decrypted = getSkillDecrypted(matchedSkill.id)
              if (decrypted?.envValues) {
                for (const [key, value] of Object.entries(decrypted.envValues)) {
                  if (value) {
                    process.env[key] = value
                    injectedVars.push(key)
                  }
                }
              }
            }
          } catch {
            // Skills config not available, continue without env injection
          }

          const skillName = skillMdMatch[1] // e.g. "zats/perplexity"
          const header = `Skill directory: ${skillDir}\n\n`
          return {
            content: [{ type: 'text' as const, text: header + content }],
            details: {
              path: resolved,
              size: content.length,
              skillLoad: true,
              skillName,
              envVarsInjected: injectedVars,
            },
          }
        }

        return {
          content: [{ type: 'text' as const, text: content }],
          details: { path: resolved, size: content.length },
        }
      } catch (err: unknown) {
        return {
          content: [{ type: 'text' as const, text: `Error reading file: ${(err as Error).message}` }],
          details: { error: true },
        }
      }
    },
  }

  const writeFileTool: AgentTool = {
    name: 'write_file',
    label: 'Write File',
    description: 'Write content to a file. Creates parent directories if needed.',
    parameters: Type.Object({
      path: Type.String({ description: 'Path to the file to write' }),
      content: Type.String({ description: 'Content to write to the file' }),
    }),
    execute: async (_toolCallId, params) => {
      const { path: filePath, content } = params as { path: string; content: string }
      try {
        const resolved = resolveWorkspacePath(filePath)
        const dir = nodePath.dirname(resolved)
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true })
        }
        fs.writeFileSync(resolved, content, 'utf-8')
        return {
          content: [{ type: 'text' as const, text: `Successfully wrote ${content.length} bytes to ${resolved}` }],
          details: { path: resolved, size: content.length },
        }
      } catch (err: unknown) {
        return {
          content: [{ type: 'text' as const, text: `Error writing file: ${(err as Error).message}` }],
          details: { error: true },
        }
      }
    },
  }

  const listFilesTool: AgentTool = {
    name: 'list_files',
    label: 'List Files',
    description: 'List files and directories at the given path.',
    parameters: Type.Object({
      path: Type.String({ description: 'Directory path to list' }),
    }),
    execute: async (_toolCallId, params) => {
      const { path: dirPath } = params as { path: string }
      try {
        const resolved = resolveWorkspacePath(dirPath)
        const entries = fs.readdirSync(resolved, { withFileTypes: true })
        const listing = entries.map(e =>
          `${e.isDirectory() ? '[dir]' : '[file]'} ${e.name}`
        ).join('\n')
        return {
          content: [{ type: 'text' as const, text: listing || '(empty directory)' }],
          details: { path: resolved, count: entries.length },
        }
      } catch (err: unknown) {
        return {
          content: [{ type: 'text' as const, text: `Error listing directory: ${(err as Error).message}` }],
          details: { error: true },
        }
      }
    },
  }

  return [shellTool, readFileTool, writeFileTool, listFilesTool]
}

/**
 * Load active skill entries for system prompt injection
 */
function getActiveSkillEntries(): SkillPromptEntry[] {
  try {
    const skillsFile = loadSkills()
    return skillsFile.skills
      .filter(s => s.enabled)
      .map(s => ({
        name: s.name,
        description: s.description,
        location: s.path,
      }))
  } catch {
    return []
  }
}

/**
 * Agent Core - manages the message lifecycle using pi-mono SDK
 */
export class AgentCore {
  private agent: PiAgent
  private model: Model<Api>
  private apiKey: string
  private db: Database
  private sessionManager: SessionManager
  private toolCallTimers: Map<string, number> = new Map() // toolCallId -> startTime
  private toolCallArgs: Map<string, unknown> = new Map() // toolCallId -> args
  private memoryDir?: string
  private baseInstructions?: string
  private providerConfig?: ProviderConfig
  private providerManager?: ProviderManager
  private onSessionEndCallback?: (userId: string, summary: string | null) => void
  private onTaskInjectionChunkCallback?: (chunk: ResponseChunk) => void
  private messageQueue: MessageQueue

  constructor(options: AgentCoreOptions) {
    this.model = options.model
    this.apiKey = options.apiKey
    this.db = options.db
    this.memoryDir = options.memoryDir
    this.baseInstructions = options.baseInstructions
    this.providerConfig = options.providerConfig
    this.providerManager = options.providerManager
    this.onSessionEndCallback = options.onSessionEnd

    // Ensure memory structure exists
    ensureMemoryStructure(options.memoryDir)

    // Load language, timezone, and builtinTools settings from config
    let language: string | undefined
    let timezone: string | undefined
    let builtinToolsConfig: BuiltinToolsConfig | undefined
    try {
      ensureConfigTemplates()
      const settings = loadConfig<{ language?: string; timezone?: string; builtinTools?: BuiltinToolsConfig }>('settings.json')
      language = settings.language
      timezone = settings.timezone
      builtinToolsConfig = settings.builtinTools
    } catch {
      // Config not available yet, use default
    }

    // Load active skills for system prompt
    const activeSkills = getActiveSkillEntries()

    // Build system prompt from memory
    const systemPrompt = options.systemPrompt ?? assembleSystemPrompt({
      memoryDir: options.memoryDir,
      baseInstructions: options.baseInstructions,
      language,
      timezone,
      skills: activeSkills,
    })

    const tools: AgentTool[] = [
      ...(options.tools ?? []),
      ...createMemoryTools(options.memoryDir),
      ...createBuiltinWebTools(builtinToolsConfig),
      ...(options.yoloMode !== false ? createYoloTools() : []),
    ]

    this.agent = new PiAgent({
      initialState: {
        systemPrompt,
        model: this.model,
        tools,
      },
      getApiKey: this.providerConfig?.authMethod === 'oauth'
        ? async () => {
            try {
              // Reload provider config to get latest OAuth credentials
              const { loadProvidersDecrypted } = await import('./provider-config.js')
              const file = loadProvidersDecrypted()
              const freshProvider = file.providers.find(p => p.id === this.providerConfig!.id)
              if (freshProvider) {
                return await getApiKeyForProvider(freshProvider)
              }
            } catch (err) {
              console.error('OAuth token refresh failed:', err)
            }
            return this.apiKey
          }
        : () => this.apiKey,
    })

    // Initialize message queue for sequential processing
    this.messageQueue = new MessageQueue()

    // Initialize session manager
    this.sessionManager = new SessionManager({
      db: this.db,
      timeoutMinutes: options.sessionTimeoutMinutes ?? 15,
      memoryDir: options.memoryDir,
      onSummarize: async (_sessionId: string, userId: string) => {
        return this.generateSessionSummary(userId)
      },
      onSessionEnd: (session: SessionInfo, summary: string | null) => {
        // Only clear agent messages for non-system sessions.
        // System sessions (from task injections) share the same agent instance,
        // and clearing messages here would wipe the user's conversation history
        // before their session has a chance to generate a summary.
        if (session.userId !== 'system') {
          this.agent.clearMessages()
          this.refreshSystemPrompt()
        }

        // Notify external listener (e.g. ws-chat)
        if (this.onSessionEndCallback) {
          this.onSessionEndCallback(session.userId, summary)
        }
      },
    })
  }

  /**
   * Get the session manager
   */
  getSessionManager(): SessionManager {
    return this.sessionManager
  }

  /**
   * Hot-swap the provider at runtime while preserving conversation context.
   * Updates model, apiKey, and providerConfig, then calls agent.setModel().
   */
  swapProvider(provider: ProviderConfig, apiKey: string): void {
    this.model = buildModel(provider)
    this.apiKey = apiKey
    this.providerConfig = provider
    this.agent.setModel(this.model)
  }

  /**
   * Get the ProviderManager reference (if configured).
   */
  getProviderManager(): ProviderManager | undefined {
    return this.providerManager
  }

  /**
   * Send a message and get back an async iterable of response chunks.
   * All messages are queued and processed sequentially to prevent collisions.
   */
  async *sendMessage(userId: string, text: string, source: string = 'web', attachments?: UploadDescriptor[]): AsyncIterable<ResponseChunk> {
    const self = this
    const uploads = attachments
    const iterable = await this.messageQueue.enqueue<ResponseChunk>(
      'user_message',
      userId,
      text,
      source,
      (msg) => {
        return self.processUserMessage(msg.payload.userId, msg.payload.text, msg.payload.source, uploads)
      },
    )
    yield* iterable
  }

  /**
   * Inject a task result into the main agent via the message queue.
   * The injection is queued and processed sequentially like any other message.
   */
  async injectTaskResult(injection: string): Promise<void> {
    const self = this
    const iterable = await this.messageQueue.enqueue<ResponseChunk>(
      'task_injection',
      'system',
      injection,
      'task',
      (msg) => {
        return self.processTaskInjection(msg.payload.text)
      },
    )
    // Stream response chunks via callback (if set), otherwise drain silently
    for await (const chunk of iterable) {
      this.onTaskInjectionChunkCallback?.(chunk)
    }
  }

  /**
   * Process a user message (called from the queue)
   */
  private async *processUserMessage(userId: string, text: string, source: string, attachments?: UploadDescriptor[]): AsyncIterable<ResponseChunk> {
    const session = this.sessionManager.getOrCreateSession(userId, source)
    const sessionId = session.id

    this.refreshSystemPrompt(source)
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
    yield* this.executePromptWithRetry(enrichedText, sessionId, false, images.length > 0 ? images : undefined)
  }

  /**
   * Process a task injection by sending it through the agent
   */
  private async *processTaskInjection(injection: string): AsyncIterable<ResponseChunk> {
    const session = this.sessionManager.getOrCreateSession('system', 'task')
    const sessionId = session.id

    this.sessionManager.recordMessage('system')

    yield* this.executePromptWithRetry(injection, sessionId)
  }

  /**
   * Check if an error is a retryable pre-stream error (429, 5xx, connection refused).
   */
  private isRetryablePreStreamError(err: unknown): boolean {
    const message = (err instanceof Error ? err.message : String(err)).toLowerCase()

    // HTTP 429 rate limit
    if (message.includes('429') || message.includes('rate limit') || message.includes('too many requests')) {
      return true
    }

    // HTTP 5xx server errors
    if (/\b5\d{2}\b/.test(message) || message.includes('internal server error') || message.includes('bad gateway') || message.includes('service unavailable') || message.includes('gateway timeout')) {
      return true
    }

    // Connection errors
    if (message.includes('econnrefused') || message.includes('econnreset') || message.includes('enotfound') || message.includes('connection refused') || message.includes('fetch failed')) {
      return true
    }

    return false
  }

  /**
   * Execute a prompt with optional fallback retry on pre-stream errors.
   */
  private async *executePromptWithRetry(text: string, sessionId: string, isRetry: boolean = false, images?: ImageContent[]): AsyncIterable<ResponseChunk> {
    const eventQueue: AgentEvent[] = []
    let resolveWaiting: (() => void) | null = null
    let done = false
    let preStreamError: unknown = null
    let midStreamError: unknown = null

    const unsubscribe = this.agent.subscribe((event: AgentEvent) => {
      eventQueue.push(event)
      if (resolveWaiting) {
        resolveWaiting()
        resolveWaiting = null
      }
    })

    // Start the prompt (non-blocking)
    const promptPromise = this.agent.prompt(text, images).then(() => {
      done = true
      if (resolveWaiting) {
        resolveWaiting()
        resolveWaiting = null
      }
    }).catch((err) => {
      // If no events have been received yet, this is a pre-stream error
      if (eventQueue.length === 0) {
        preStreamError = err
      } else {
        // Mid-stream error — surface error to the user, then signal agent_end
        console.error('Agent prompt error (mid-stream):', err)
        midStreamError = err
        eventQueue.push({ type: 'agent_end', messages: [] })
      }
      done = true
      if (resolveWaiting) {
        resolveWaiting()
        resolveWaiting = null
      }
    })

    let yieldedDone = false

    try {
      while (true) {
        // Process all queued events
        while (eventQueue.length > 0) {
          const event = eventQueue.shift()!
          const chunks = this.processEvent(event, sessionId)
          for (const chunk of chunks) {
            if (chunk.type === 'done') yieldedDone = true
            yield chunk
          }
        }

        if (done && eventQueue.length === 0) break

        // Wait for more events
        await new Promise<void>(resolve => {
          resolveWaiting = resolve
        })
      }
    } finally {
      unsubscribe()
      await promptPromise
    }

    // Surface mid-stream errors (e.g. context window exceeded after tool calls)
    if (midStreamError) {
      const errMsg = (midStreamError instanceof Error ? midStreamError.message : String(midStreamError)) || 'Unknown error'
      console.error('Agent mid-stream error surfaced to user:', errMsg)
      yield { type: 'error' as const, error: errMsg }
    }

    // Safety net: if no 'done' chunk was yielded (e.g. agent_end never fired),
    // ensure we always signal completion so the frontend doesn't hang.
    if (!yieldedDone && !preStreamError) {
      yield { type: 'done' as const }
    }

    // Handle pre-stream error with fallback retry
    if (preStreamError) {
      const canRetry = !isRetry
        && this.providerManager
        && this.providerManager.getOperatingMode() === 'normal'
        && this.providerManager.getFallbackProvider() !== null
        && this.isRetryablePreStreamError(preStreamError)

      if (canRetry) {
        console.warn('[AgentCore] Pre-stream error detected, swapping to fallback provider:', (preStreamError as Error).message)
        this.providerManager!.swapToFallback()
        const fallback = this.providerManager!.getEffectiveProvider()!
        const apiKey = await getApiKeyForProvider(fallback)
        this.swapProvider(fallback, apiKey)

        // Retry once with fallback
        yield* this.executePromptWithRetry(text, sessionId, true, images)
        return
      }

      // No retry possible — surface the error
      console.error('Agent prompt error (pre-stream):', preStreamError)
      yield { type: 'error' as const, error: (preStreamError as Error).message ?? String(preStreamError) }
      yield { type: 'done' as const }
    }
  }

  /**
   * Handle /new command: summarize current session and start fresh
   */
  async handleNewCommand(userId: string): Promise<string | null> {
    const summary = await this.sessionManager.handleNewCommand(userId)
    return summary
  }

  /**
   * Generate a summary of the current conversation using the LLM
   */
  private async generateSessionSummary(_userId: string): Promise<string> {
    const messages = this.agent.state.messages
    if (messages.length === 0) return 'Empty session.'

    // Build a compact representation of the conversation for summarization
    const conversationLines: string[] = []
    for (const msg of messages) {
      if ('role' in msg) {
        if (msg.role === 'user') {
          const text = 'content' in msg && typeof msg.content === 'string'
            ? msg.content
            : Array.isArray(msg.content)
              ? msg.content.filter((c: { type: string }) => c.type === 'text').map((c: { type: string; text?: string }) => c.text ?? '').join('')
              : ''
          if (text) conversationLines.push(`User: ${text}`)
        } else if (msg.role === 'assistant') {
          const text = 'content' in msg && Array.isArray(msg.content)
            ? msg.content.filter((c: { type: string }) => c.type === 'text').map((c: { type: string; text?: string }) => c.text ?? '').join('')
            : ''
          if (text) conversationLines.push(`Assistant: ${text.slice(0, 500)}`)
        }
      }
    }

    if (conversationLines.length === 0) return 'Empty session.'

    // Truncate to avoid excessive token usage
    const conversationText = conversationLines.join('\n').slice(0, 4000)

    try {
      const response = await completeSimple(this.model, {
        systemPrompt: 'You are a concise summarizer. Summarize the following conversation in 2-4 bullet points. Focus on key topics discussed, decisions made, and any action items. Respond only with the bullet points, no preamble.',
        messages: [{
          role: 'user' as const,
          content: conversationText,
          timestamp: Date.now(),
        }],
      }, { apiKey: this.apiKey })

      const summary = response.content
        .filter(c => c.type === 'text')
        .map(c => (c as { type: 'text'; text: string }).text)
        .join('')
        .trim()

      return summary || 'Session ended.'
    } catch (err) {
      console.error('Failed to generate session summary:', err)
      return 'Session ended (summary generation failed).'
    }
  }

  /**
   * Set the callback for session end events
   */
  setOnSessionEnd(callback: (userId: string, summary: string | null) => void): void {
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
   * Process an agent event into response chunks
   */
  private processEvent(event: AgentEvent, sessionId: string): ResponseChunk[] {
    const chunks: ResponseChunk[] = []

    switch (event.type) {
      case 'message_update': {
        const assistantEvent = event.assistantMessageEvent
        if (assistantEvent.type === 'text_delta') {
          chunks.push({
            type: 'text',
            text: assistantEvent.delta,
          })
        }
        break
      }

      case 'message_end': {
        const msg = event.message as Message
        if (msg.role === 'assistant') {
          const assistantMsg = msg as AssistantMessage
          // Log token usage
          const cost = estimateCost(
            this.model,
            assistantMsg.usage.input,
            assistantMsg.usage.output,
            assistantMsg.usage.cacheRead,
            assistantMsg.usage.cacheWrite,
          )

          // Use pi-mono cost if available and non-zero, otherwise our estimate
          const finalCost = assistantMsg.usage.cost.total > 0
            ? assistantMsg.usage.cost.total
            : cost

          logTokenUsage(this.db, {
            provider: assistantMsg.provider,
            model: assistantMsg.model,
            promptTokens: assistantMsg.usage.input,
            completionTokens: assistantMsg.usage.output,
            estimatedCost: finalCost,
            sessionId,
          })
        }
        break
      }

      case 'tool_execution_start': {
        this.toolCallTimers.set(event.toolCallId, Date.now())
        this.toolCallArgs.set(event.toolCallId, event.args)
        chunks.push({
          type: 'tool_call_start',
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          toolArgs: event.args,
        })
        break
      }

      case 'tool_execution_end': {
        const startTime = this.toolCallTimers.get(event.toolCallId) ?? Date.now()
        const durationMs = Date.now() - startTime
        const args = this.toolCallArgs.get(event.toolCallId) ?? {}
        this.toolCallTimers.delete(event.toolCallId)
        this.toolCallArgs.delete(event.toolCallId)

        // Log tool call
        logToolCall(this.db, {
          sessionId,
          toolName: event.toolName,
          input: JSON.stringify(args),
          output: JSON.stringify(event.result ?? {}),
          durationMs,
        })

        chunks.push({
          type: 'tool_call_end',
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          toolResult: event.result,
          toolIsError: event.isError,
        })
        break
      }

      case 'agent_end': {
        chunks.push({ type: 'done' })
        break
      }
    }

    return chunks
  }

  /**
   * Abort the current agent task
   */
  abort(): void {
    this.agent.abort()
  }

  /**
   * Reset a user's session (async - generates summary before reset)
   */
  async resetSession(userId: string): Promise<string | null> {
    const summary = await this.sessionManager.handleNewCommand(userId)
    return summary
  }

  /**
   * Refresh the system prompt from current memory state
   */
  refreshSystemPrompt(channel?: string): void {
    let language: string | undefined
    let timezone: string | undefined
    try {
      ensureConfigTemplates()
      const settings = loadConfig<{ language?: string; timezone?: string }>('settings.json')
      language = settings.language
      timezone = settings.timezone
    } catch {
      // Config not available
    }

    const activeSkills = getActiveSkillEntries()

    const prompt = assembleSystemPrompt({
      memoryDir: this.memoryDir,
      baseInstructions: this.baseInstructions,
      language,
      timezone,
      channel,
      skills: activeSkills,
    })
    this.agent.setSystemPrompt(prompt)
  }

  /**
   * Refresh skills: reload skills.json and rebuild system prompt with current active skills.
   * Call this after skill install/delete/toggle.
   */
  refreshSkills(): void {
    this.refreshSystemPrompt()
  }

  /**
   * Get the message queue (for monitoring/testing)
   */
  getMessageQueue(): MessageQueue {
    return this.messageQueue
  }

  /**
   * Get the underlying pi-mono agent (for advanced usage)
   */
  getAgent(): PiAgent {
    return this.agent
  }

  /**
   * Dispose all sessions and clean up
   */
  async dispose(): Promise<void> {
    await this.sessionManager.dispose()
  }
}
