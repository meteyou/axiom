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
import { assembleSystemPrompt, ensureMemoryStructure, ensureConfigStructure, getMemoryDir } from './memory.js'
import type { SkillPromptEntry } from './memory.js'
import { getWorkspaceDir } from './workspace.js'
import { loadConfig, ensureConfigTemplates } from './config.js'
import { loadSkills, getSkillDecrypted } from './skill-config.js'
import { getUploadsDir } from './uploads.js'
import type { UploadDescriptor } from './uploads.js'
import { createBuiltinWebTools } from './web-tools.js'
import type { BuiltinToolsConfig } from './web-tools.js'
import { createTranscribeAudioTool } from './stt-tool.js'
import { loadSttSettings } from './stt.js'
import { SessionManager } from './session-manager.js'
import type { SessionInfo } from './session-manager.js'
import { MessageQueue } from './message-queue.js'
import { createAgentSkillTools, getAgentSkillsForPrompt, getAgentSkillsCount, getAgentSkillsDir, trackAgentSkillUsage } from './agent-skills.js'

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

        // Detect SKILL.md loads under /data/skills_agent/<name>/
        const agentSkillMdMatch = resolved.match(/\/data\/skills_agent\/([^/]+)\/SKILL\.md$/)
        if (agentSkillMdMatch) {
          const skillDir = nodePath.dirname(resolved)
          content = content.replaceAll('{baseDir}', skillDir)
          const skillName = agentSkillMdMatch[1]
          trackAgentSkillUsage(skillName)
          const header = `Skill directory: ${skillDir}\n\n`
          return {
            content: [{ type: 'text' as const, text: header + content }],
            details: {
              path: resolved,
              size: content.length,
              skillLoad: true,
              skillName,
              agentSkill: true,
            },
          }
        }

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

        // Capture before-content for memory files (enables diff view in UI)
        let memoryDiff: { before: string; after: string } | undefined
        const memoryDir = getMemoryDir()
        if (resolved.startsWith(memoryDir)) {
          const before = fs.existsSync(resolved) ? fs.readFileSync(resolved, 'utf-8') : ''
          memoryDiff = { before, after: content }
        }

        fs.writeFileSync(resolved, content, 'utf-8')
        return {
          content: [{ type: 'text' as const, text: `Successfully wrote ${content.length} bytes to ${resolved}` }],
          details: { path: resolved, size: content.length, memoryDiff },
        }
      } catch (err: unknown) {
        return {
          content: [{ type: 'text' as const, text: `Error writing file: ${(err as Error).message}` }],
          details: { error: true },
        }
      }
    },
  }

  const editFileTool: AgentTool = {
    name: 'edit_file',
    label: 'Edit File',
    description: 'Edit a file using exact text replacements. Each edit specifies an oldText to find and a newText to replace it with. The oldText must match exactly and be unique in the file. Use this instead of write_file when you only need to change specific parts of a file.',
    parameters: Type.Object({
      path: Type.String({ description: 'Path to the file to edit' }),
      edits: Type.Array(
        Type.Object({
          oldText: Type.String({ description: 'Exact text to find and replace. Must be unique in the file.' }),
          newText: Type.String({ description: 'Replacement text.' }),
        }),
        { description: 'One or more targeted replacements. Each oldText is matched against the original file.' },
      ),
    }),
    execute: async (_toolCallId, params) => {
      const { path: filePath, edits } = params as { path: string; edits: Array<{ oldText: string; newText: string }> }
      try {
        const resolved = resolveWorkspacePath(filePath)

        if (!fs.existsSync(resolved)) {
          return {
            content: [{ type: 'text' as const, text: `File not found: ${resolved}` }],
            details: { error: true },
          }
        }

        if (!Array.isArray(edits) || edits.length === 0) {
          return {
            content: [{ type: 'text' as const, text: 'edits must contain at least one replacement.' }],
            details: { error: true },
          }
        }

        const originalContent = fs.readFileSync(resolved, 'utf-8')
        let content = originalContent

        // Validate all edits first (against original content)
        for (let i = 0; i < edits.length; i++) {
          const { oldText } = edits[i]
          if (!oldText) {
            return {
              content: [{ type: 'text' as const, text: `edits[${i}].oldText must not be empty.` }],
              details: { error: true },
            }
          }
          const occurrences = content.split(oldText).length - 1
          if (occurrences === 0) {
            return {
              content: [{ type: 'text' as const, text: `Could not find edits[${i}].oldText in ${filePath}. The text must match exactly.` }],
              details: { error: true },
            }
          }
          if (occurrences > 1) {
            return {
              content: [{ type: 'text' as const, text: `Found ${occurrences} occurrences of edits[${i}].oldText in ${filePath}. The text must be unique.` }],
              details: { error: true },
            }
          }
        }

        // Apply all edits
        for (const { oldText, newText } of edits) {
          content = content.replace(oldText, newText)
        }

        if (content === originalContent) {
          return {
            content: [{ type: 'text' as const, text: `No changes made to ${filePath}. The replacements produced identical content.` }],
            details: { error: true },
          }
        }

        // Capture before/after for memory files (enables diff view in UI)
        let memoryDiff: { before: string; after: string } | undefined
        const memoryDir = getMemoryDir()
        if (resolved.startsWith(memoryDir)) {
          memoryDiff = { before: originalContent, after: content }
        }

        fs.writeFileSync(resolved, content, 'utf-8')
        return {
          content: [{ type: 'text' as const, text: `Successfully replaced ${edits.length} block(s) in ${filePath}.` }],
          details: { path: resolved, editsApplied: edits.length, memoryDiff },
        }
      } catch (err: unknown) {
        return {
          content: [{ type: 'text' as const, text: `Error editing file: ${(err as Error).message}` }],
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

  return [shellTool, readFileTool, writeFileTool, editFileTool, listFilesTool]
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
  private onSessionEndCallback?: (userId: string, sessionId: string, summary: string | null) => void
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
    ensureConfigStructure()

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

    // Load recent agent-managed skills for system prompt
    const agentSkillEntries = getAgentSkillsForPrompt()
    const totalAgentSkills = getAgentSkillsCount()
    const allSkills = [...activeSkills, ...agentSkillEntries]

    // Check if STT is enabled for transcribe_audio tool and system prompt
    let sttEnabled = false
    try {
      sttEnabled = loadSttSettings().enabled
    } catch {
      // STT settings not available
    }

    // Merge STT enabled state into builtinTools config for system prompt
    const builtinToolsPromptConfig = {
      ...builtinToolsConfig,
      stt: { enabled: sttEnabled },
    }

    // Build system prompt from memory
    const systemPrompt = options.systemPrompt ?? assembleSystemPrompt({
      memoryDir: options.memoryDir,
      baseInstructions: options.baseInstructions,
      language,
      timezone,
      skills: allSkills,
      agentSkillsOverflowCount: totalAgentSkills > 10 ? totalAgentSkills : undefined,
      builtinTools: builtinToolsPromptConfig,
      agentSkillsDir: getAgentSkillsDir(),
    })

    const tools: AgentTool[] = [
      ...(options.tools ?? []),
      ...createBuiltinWebTools(builtinToolsConfig),
      ...(sttEnabled ? [createTranscribeAudioTool()] : []),
      ...createAgentSkillTools(),
      ...createYoloTools(),
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
      onSummarize: async (_sessionId: string, userId: string, conversationHistory?: string) => {
        return this.generateSessionSummary(userId, conversationHistory)
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
    yield* this.executePromptWithRetry(enrichedText, sessionId, false, images.length > 0 ? images : undefined)

    // Count the agent response as a message too
    this.sessionManager.recordMessage(userId)
  }

  /**
   * Process a task injection by sending it through the agent
   */
  private async *processTaskInjection(injection: string): AsyncIterable<ResponseChunk> {
    const session = this.sessionManager.getOrCreateSession('system', 'task')
    const sessionId = session.id

    this.sessionManager.recordMessage('system')

    yield* this.executePromptWithRetry(injection, sessionId)

    // Count the agent response as a message too
    this.sessionManager.recordMessage('system')
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
   * Generate a summary of the current conversation using the LLM.
   * Returns a combined activity log entry that may include an optional
   * "### Offene Fäden" (open threads) section when unresolved items exist.
   */
  private async generateSessionSummary(_userId: string, conversationHistory?: string): Promise<string> {
    // Always use DB conversation history (single source of truth).
    // In-memory agent messages can disappear on provider change or restart,
    // but chat_messages in the DB are always reliable.
    if (!conversationHistory) return 'Empty session.'

    try {
      const response = await completeSimple(this.model, {
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
          content: conversationHistory,
          timestamp: Date.now(),
        }],
      }, {
        apiKey: this.apiKey,
        temperature: 0,
      })

      const summary = response.content
        .filter(c => c.type === 'text')
        .map(c => (c as { type: 'text'; text: string }).text)
        .join('')
        .trim()

      return summary || 'Empty session.'
    } catch (err) {
      console.error('Failed to generate session summary:', err)
      return 'Session ended (summary generation failed).'
    }
  }

  /**
   * Set the callback for session end events
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
   * End all active sessions and emit session_end events.
   */
  async endAllSessions(): Promise<void> {
    await this.sessionManager.endAllSessions('provider_change')
  }

  /**
   * Refresh the system prompt from current memory state
   */
  refreshSystemPrompt(channel?: string, currentUser?: { username: string }): void {
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
      // Config not available
    }

    const activeSkills = getActiveSkillEntries()
    const agentSkillEntries = getAgentSkillsForPrompt()
    const totalAgentSkills = getAgentSkillsCount()
    const allSkills = [...activeSkills, ...agentSkillEntries]

    // Check STT enabled for system prompt
    let sttEnabled = false
    try {
      sttEnabled = loadSttSettings().enabled
    } catch {
      // STT settings not available
    }

    const builtinToolsPromptConfig = {
      ...builtinToolsConfig,
      stt: { enabled: sttEnabled },
    }

    const prompt = assembleSystemPrompt({
      memoryDir: this.memoryDir,
      baseInstructions: this.baseInstructions,
      language,
      timezone,
      channel,
      skills: allSkills,
      agentSkillsOverflowCount: totalAgentSkills > 10 ? totalAgentSkills : undefined,
      currentUser,
      builtinTools: builtinToolsPromptConfig,
      agentSkillsDir: getAgentSkillsDir(),
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
