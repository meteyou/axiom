import { execSync } from 'node:child_process'
import fs from 'node:fs'
import nodePath from 'node:path'
import { Agent as PiAgent } from '@mariozechner/pi-agent-core'
import type { AgentEvent, AgentTool } from '@mariozechner/pi-agent-core'
import type { Api, AssistantMessage, Message, Model } from '@mariozechner/pi-ai'
import { Type } from '@mariozechner/pi-ai'
import type { Database } from './database.js'
import { logTokenUsage, logToolCall } from './token-logger.js'
import { estimateCost } from './provider-config.js'
import { assembleSystemPrompt, ensureMemoryStructure } from './memory.js'
import { loadConfig, ensureConfigTemplates } from './config.js'
import { createMemoryTools } from './memory-tools.js'
import { SessionManager } from './session-manager.js'
import type { SessionInfo } from './session-manager.js'

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
}

/**
 * Build YOLO-mode tools that give the agent unrestricted access
 */
function createYoloTools(): AgentTool[] {
  const shellTool: AgentTool = {
    name: 'shell',
    label: 'Execute Shell Command',
    description: 'Execute a shell command and return stdout/stderr. Use this for any system operation.',
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
          cwd: process.env.WORKSPACE_DIR ?? '/workspace',
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
        const resolved = nodePath.resolve(filePath)
        const content = fs.readFileSync(resolved, 'utf-8')
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
        const resolved = nodePath.resolve(filePath)
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
        const resolved = nodePath.resolve(dirPath)
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

  constructor(options: AgentCoreOptions) {
    this.model = options.model
    this.apiKey = options.apiKey
    this.db = options.db
    this.memoryDir = options.memoryDir
    this.baseInstructions = options.baseInstructions

    // Ensure memory structure exists
    ensureMemoryStructure(options.memoryDir)

    // Load language setting from config
    let language: string | undefined
    try {
      ensureConfigTemplates()
      const settings = loadConfig<{ language?: string }>('settings.json')
      language = settings.language
    } catch {
      // Config not available yet, use default
    }

    // Build system prompt from memory
    const systemPrompt = options.systemPrompt ?? assembleSystemPrompt({
      memoryDir: options.memoryDir,
      baseInstructions: options.baseInstructions,
      language,
    })

    const tools: AgentTool[] = [
      ...(options.tools ?? []),
      ...createMemoryTools(options.memoryDir),
      ...(options.yoloMode !== false ? createYoloTools() : []),
    ]

    this.agent = new PiAgent({
      initialState: {
        systemPrompt,
        model: this.model,
        tools,
      },
      getApiKey: () => this.apiKey,
    })

    // Initialize session manager
    this.sessionManager = new SessionManager({
      db: this.db,
      timeoutMinutes: options.sessionTimeoutMinutes ?? 15,
      memoryDir: options.memoryDir,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      onSessionEnd: (_session: SessionInfo) => {
        // Clear agent messages when session ends
        this.agent.clearMessages()

        // Rebuild system prompt with fresh memory context
        this.refreshSystemPrompt()
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
   * Send a message and get back an async iterable of response chunks
   */
  async *sendMessage(userId: string, text: string, source: string = 'web'): AsyncIterable<ResponseChunk> {
    // Get or create session
    const session = this.sessionManager.getOrCreateSession(userId, source)
    const sessionId = session.id

    // Record the message
    this.sessionManager.recordMessage(userId)

    // Collect events via subscription
    const eventQueue: AgentEvent[] = []
    let resolveWaiting: (() => void) | null = null
    let done = false

    const unsubscribe = this.agent.subscribe((event: AgentEvent) => {
      eventQueue.push(event)
      if (resolveWaiting) {
        resolveWaiting()
        resolveWaiting = null
      }
    })

    // Start the prompt (non-blocking)
    const promptPromise = this.agent.prompt(text).then(() => {
      done = true
      if (resolveWaiting) {
        resolveWaiting()
        resolveWaiting = null
      }
    }).catch((err) => {
      eventQueue.push({ type: 'agent_end', messages: [] })
      done = true
      if (resolveWaiting) {
        resolveWaiting()
        resolveWaiting = null
      }
      console.error('Agent prompt error:', err)
    })

    try {
      while (true) {
        // Process all queued events
        while (eventQueue.length > 0) {
          const event = eventQueue.shift()!
          const chunks = this.processEvent(event, sessionId)
          for (const chunk of chunks) {
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
  }

  /**
   * Handle /new command: summarize current session and start fresh
   */
  async handleNewCommand(userId: string): Promise<string | null> {
    return this.sessionManager.handleNewCommand(userId)
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
   * Reset a user's session
   */
  resetSession(userId: string): void {
    this.sessionManager.handleNewCommand(userId)
    this.agent.clearMessages()
  }

  /**
   * Refresh the system prompt from current memory state
   */
  refreshSystemPrompt(): void {
    let language: string | undefined
    try {
      ensureConfigTemplates()
      const settings = loadConfig<{ language?: string }>('settings.json')
      language = settings.language
    } catch {
      // Config not available
    }

    const prompt = assembleSystemPrompt({
      memoryDir: this.memoryDir,
      baseInstructions: this.baseInstructions,
      language,
    })
    this.agent.setSystemPrompt(prompt)
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
