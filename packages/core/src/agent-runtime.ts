import { execSync } from 'node:child_process'
import fs from 'node:fs'
import nodePath from 'node:path'
import { Agent as PiAgent } from '@mariozechner/pi-agent-core'
import type { AgentEvent, AgentTool } from '@mariozechner/pi-agent-core'
import type { Api, AssistantMessage, Message, ImageContent, Model } from '@mariozechner/pi-ai'
import { Type } from '@mariozechner/pi-ai'
import type { Database } from './database.js'
import { logTokenUsage, logToolCall } from './token-logger.js'
import { estimateCost, getApiKeyForProvider, buildModel } from './provider-config.js'
import type { ProviderConfig } from './provider-config.js'
import type { ProviderManager } from './provider-manager.js'
import type { SettingsThinkingLevel } from './contracts/settings.js'
import { normalizeThinkingLevel } from './thinking-level.js'
import { assembleSystemPrompt, ensureMemoryStructure, ensureConfigStructure, getMemoryDir } from './memory.js'
import type { SkillPromptEntry } from './memory.js'
import { getWorkspaceDir } from './workspace.js'
import { loadConfig, ensureConfigTemplates } from './config.js'
import { loadSkills, getSkillDecrypted } from './skill-config.js'
import { createBuiltinWebTools } from './web-tools.js'
import type { BuiltinToolsConfig } from './web-tools.js'
import { createTranscribeAudioTool } from './stt-tool.js'
import { loadSttSettings } from './stt.js'
import { createAgentSkillTools, getAgentSkillsForPrompt, getAgentSkillsCount, getAgentSkillsDir, trackAgentSkillUsage } from './agent-skills.js'
import { createSearchMemoriesTool } from './memories-tool.js'
import { createReadChatHistoryTool } from './chat-history-tools.js'
import type { AgentRuntimeStateSnapshot, ResponseChunk } from './agent-runtime-types.js'

/**
 * Options for the shared base agent tool factory.
 * Both the interactive AgentCore and background task agents use this to
 * build the common tool set — keeping the two paths in sync automatically.
 */
export interface BaseAgentToolsOptions {
  db: Database
  builtinToolsConfig?: BuiltinToolsConfig
  sttEnabled?: boolean
  /** Called by search_memories to scope results to the current user. */
  getCurrentUserId?: () => number | undefined
}

/**
 * Build the base tool set shared by the interactive agent and all background
 * task agents (heartbeat, cronjob, user-spawned tasks).
 *
 * Callers add their exclusive tools on top:
 * - Interactive agent: create_task, resume_task, list_tasks, cronjob tools
 * - Background tasks: create_task, resume_task, list_tasks
 */
export function createBaseAgentTools(options: BaseAgentToolsOptions): AgentTool[] {
  return [
    ...createYoloTools(),
    ...createBuiltinWebTools(options.builtinToolsConfig),
    createReadChatHistoryTool({ db: options.db }),
    createSearchMemoriesTool({ db: options.db, getCurrentUserId: options.getCurrentUserId }),
    ...createAgentSkillTools(),
    ...(options.sttEnabled ? [createTranscribeAudioTool()] : []),
  ]
}

export interface AgentRuntimeOptions {
  model: Model<Api>
  apiKey: string
  db: Database
  systemPrompt?: string
  tools?: AgentTool[]
  memoryDir?: string
  baseInstructions?: string
  providerConfig?: ProviderConfig
  providerManager?: ProviderManager
  getCurrentToolUserId?: () => number | undefined
  /**
   * Reasoning / thinking level applied to every LLM turn. Defaults to the value
   * stored in `settings.json` (`thinkingLevel`), or `off` if not configured.
   */
  thinkingLevel?: SettingsThinkingLevel
}

export interface AgentRuntimeBoundary {
  streamPrompt(text: string, sessionId: string, images?: ImageContent[]): AsyncIterable<ResponseChunk>
  refreshSystemPrompt(channel?: string, currentUser?: { username: string }): void
  swapProvider(provider: ProviderConfig, apiKey: string, modelId?: string): void
  getProviderManager(): ProviderManager | undefined
  clearMessages(): void
  abort(): void
  getStateSnapshot(): AgentRuntimeStateSnapshot
  getCurrentModel(): Model<Api>
  getCurrentApiKey(): string
  /** Update the thinking level used for future turns. */
  setThinkingLevel(level: SettingsThinkingLevel | string): void
}

/**
 * Escape hatch for legacy integrations that still need direct pi-agent access.
 * Not part of AgentRuntimeBoundary to keep the abstraction clean.
 */
export interface AgentRuntimePiAgentAccess {
  getAgent(): PiAgent
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
 * Check if an error is a retryable pre-stream error (429, 5xx, connection refused).
 */
export function isRetryablePreStreamError(err: unknown): boolean {
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
 * Load active skill entries for system prompt injection.
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

class PiAgentRuntime implements AgentRuntimeBoundary, AgentRuntimePiAgentAccess {
  private agent: PiAgent
  private model: Model<Api>
  private apiKey: string
  private db: Database
  private toolCallTimers: Map<string, number> = new Map() // toolCallId -> startTime
  private toolCallArgs: Map<string, unknown> = new Map() // toolCallId -> args
  private memoryDir?: string
  private baseInstructions?: string
  private providerConfig?: ProviderConfig
  private providerManager?: ProviderManager
  private getCurrentToolUserId: () => number | undefined

  constructor(options: AgentRuntimeOptions) {
    this.model = options.model
    this.apiKey = options.apiKey
    this.db = options.db
    this.memoryDir = options.memoryDir
    this.baseInstructions = options.baseInstructions
    this.providerConfig = options.providerConfig
    this.providerManager = options.providerManager
    this.getCurrentToolUserId = options.getCurrentToolUserId ?? (() => undefined)

    // Ensure memory/config structure exists before prompt assembly.
    ensureMemoryStructure(options.memoryDir)
    ensureConfigStructure()

    const { builtinToolsConfig, sttEnabled, thinkingLevel: storedThinkingLevel } = this.readRuntimeSettings()
    const effectiveThinkingLevel = normalizeThinkingLevel(options.thinkingLevel) ?? storedThinkingLevel ?? 'off'

    const systemPrompt = options.systemPrompt ?? this.buildSystemPrompt()

    const tools: AgentTool[] = [
      ...(options.tools ?? []),
      ...createBaseAgentTools({
        db: this.db,
        builtinToolsConfig,
        sttEnabled,
        getCurrentUserId: () => this.getCurrentToolUserId(),
      }),
    ]

    this.agent = new PiAgent({
      initialState: {
        systemPrompt,
        model: this.model,
        tools,
        thinkingLevel: effectiveThinkingLevel,
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
  }

  streamPrompt(text: string, sessionId: string, images?: ImageContent[]): AsyncIterable<ResponseChunk> {
    return this.executePromptWithRetry(text, sessionId, false, images)
  }

  refreshSystemPrompt(channel?: string, currentUser?: { username: string }): void {
    this.agent.state.systemPrompt = this.buildSystemPrompt(channel, currentUser)
  }

  setThinkingLevel(level: SettingsThinkingLevel | string): void {
    const normalized = normalizeThinkingLevel(level)
    if (!normalized) return
    this.agent.state.thinkingLevel = normalized
  }

  swapProvider(provider: ProviderConfig, apiKey: string, modelId?: string): void {
    this.model = buildModel(provider, modelId)
    this.apiKey = apiKey
    this.providerConfig = provider
    this.agent.state.model = this.model
  }

  getProviderManager(): ProviderManager | undefined {
    return this.providerManager
  }

  clearMessages(): void {
    this.agent.state.messages = []
  }

  abort(): void {
    this.agent.abort()
  }

  getAgent(): PiAgent {
    return this.agent
  }

  getStateSnapshot(): AgentRuntimeStateSnapshot {
    return {
      modelId: this.model.id,
      toolNames: this.agent.state.tools.map(tool => tool.name),
      messageCount: this.agent.state.messages.length,
    }
  }

  getCurrentModel(): Model<Api> {
    return this.model
  }

  getCurrentApiKey(): string {
    return this.apiKey
  }

  private readRuntimeSettings(): {
    language: string | undefined
    timezone: string | undefined
    builtinToolsConfig: BuiltinToolsConfig | undefined
    sttEnabled: boolean
    thinkingLevel: SettingsThinkingLevel | undefined
  } {
    let language: string | undefined
    let timezone: string | undefined
    let builtinToolsConfig: BuiltinToolsConfig | undefined
    let thinkingLevel: SettingsThinkingLevel | undefined
    try {
      ensureConfigTemplates()
      const settings = loadConfig<{
        language?: string
        timezone?: string
        builtinTools?: BuiltinToolsConfig
        thinkingLevel?: string
      }>('settings.json')
      language = settings.language
      timezone = settings.timezone
      builtinToolsConfig = settings.builtinTools
      thinkingLevel = normalizeThinkingLevel(settings.thinkingLevel)
    } catch {
      // Config not available yet, use defaults
    }

    let sttEnabled = false
    try {
      sttEnabled = loadSttSettings().enabled
    } catch {
      // STT settings not available
    }

    return { language, timezone, builtinToolsConfig, sttEnabled, thinkingLevel }
  }

  private buildSystemPrompt(channel?: string, currentUser?: { username: string }): string {
    const { language, timezone, builtinToolsConfig, sttEnabled } = this.readRuntimeSettings()

    const activeSkills = getActiveSkillEntries()
    const agentSkillEntries = getAgentSkillsForPrompt()
    const totalAgentSkills = getAgentSkillsCount()
    const allSkills = [...activeSkills, ...agentSkillEntries]

    const builtinToolsPromptConfig = {
      ...builtinToolsConfig,
      stt: { enabled: sttEnabled },
    }

    return assembleSystemPrompt({
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
        && isRetryablePreStreamError(preStreamError)

      if (canRetry) {
        console.warn('[AgentRuntime] Pre-stream error detected, swapping to fallback provider:', (preStreamError as Error).message)
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
   * Process an agent event into response chunks.
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
        } else if (assistantEvent.type === 'thinking_delta') {
          chunks.push({
            type: 'thinking',
            thinking: assistantEvent.delta,
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
}

export function createAgentRuntime(options: AgentRuntimeOptions): AgentRuntimeBoundary {
  return new PiAgentRuntime(options)
}
