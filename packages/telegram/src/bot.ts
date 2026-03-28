import fs from 'node:fs'
import path from 'node:path'
import { Bot, GrammyError, HttpError } from 'grammy'
import type { Context } from 'grammy'
import type { AgentCore, Database } from '@openagent/core'
import { loadConfig } from '@openagent/core'

/**
 * Telegram config stored in /data/config/telegram.json
 */
export interface TelegramConfig {
  enabled: boolean
  botToken: string
  adminUserIds: number[]
  pollingMode: boolean
  webhookUrl: string
  batchingDelayMs: number
}

/**
 * Chat event emitted by the Telegram bot for cross-channel sync.
 */
export interface TelegramChatEvent {
  type: 'user_message' | 'text' | 'tool_call_start' | 'tool_call_end' | 'done' | 'error'
  /** OpenAgent user ID (integer) — only set for linked users */
  userId: number | null
  /** Session ID used for chat_messages */
  sessionId: string
  /** Text content */
  text?: string
  /** Tool name */
  toolName?: string
  /** Tool call ID */
  toolCallId?: string
  /** Tool arguments */
  toolArgs?: unknown
  /** Tool result */
  toolResult?: unknown
  /** Whether the tool call errored */
  toolIsError?: boolean
  /** Display name of the sender */
  senderName?: string
}

export interface TelegramBotOptions {
  agentCore: AgentCore
  db?: Database
  config?: TelegramConfig
  onQueueDepthChanged?: (queueDepth: number) => void
  /** Called for every chat event (user message, response chunks, etc.) for cross-channel sync */
  onChatEvent?: (event: TelegramChatEvent) => void
}

export type TelegramUserStatus = 'pending' | 'approved' | 'rejected'

export interface TelegramUserRow {
  id: number
  telegram_id: string
  telegram_username: string | null
  telegram_display_name: string | null
  status: TelegramUserStatus
  user_id: number | null
  created_at: string
  updated_at: string
}

interface TelegramSettings {
  batchingDelayMs?: number
}

interface QueuedMessage {
  ctx: Context
  text: string
}

interface PendingBatch {
  ctx: Context
  text: string
  timer: ReturnType<typeof setTimeout>
}

interface ChatState {
  pendingBatch: PendingBatch | null
  queue: QueuedMessage[]
  processing: boolean
  abortRequested: boolean
}

/** Telegram's maximum message length */
const MAX_MESSAGE_LENGTH = 4096
const STOP_COMMANDS = new Set(['/stop', '/kill'])

/**
 * Split a long text into chunks that fit within Telegram's message limit.
 * Tries to split at newline boundaries when possible.
 */
function splitMessage(text: string, maxLen: number = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= maxLen) return [text]

  const parts: string[] = []
  let remaining = text

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      parts.push(remaining)
      break
    }

    // Try to find a good split point (newline) within the limit
    let splitAt = remaining.lastIndexOf('\n', maxLen)
    if (splitAt <= 0 || splitAt < maxLen * 0.5) {
      // No good newline found; try space
      splitAt = remaining.lastIndexOf(' ', maxLen)
    }
    if (splitAt <= 0 || splitAt < maxLen * 0.5) {
      // Hard split at max length
      splitAt = maxLen
    }

    parts.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt).trimStart()
  }

  return parts
}

/**
 * Build user context prefix for the agent
 */
function formatUserContext(ctx: Context): string {
  const from = ctx.from
  if (!from) return ''

  const username = from.username ? `@${from.username}` : null
  const displayName = [from.first_name, from.last_name].filter(Boolean).join(' ')

  if (username && displayName) {
    return `Message from ${username} (${displayName}): `
  } else if (username) {
    return `Message from ${username}: `
  } else if (displayName) {
    return `Message from ${displayName}: `
  }

  return ''
}

/**
 * Get a unique user identifier for session management
 */
function getUserId(ctx: Context): string {
  return `telegram-${ctx.from?.id ?? 'unknown'}`
}

function getChatKey(ctx: Context): string {
  return `telegram-chat-${ctx.chat?.id ?? ctx.from?.id ?? 'unknown'}`
}

function isHandledCommand(text: string): boolean {
  return /^\/(start|new|stop|kill)(?:@[\w_]+)?\b/i.test(text.trim())
}

function normalizeCommand(text: string): string {
  return text.trim().split(/\s+/, 1)[0].toLowerCase().replace(/@[\w_]+$/, '')
}

function loadTelegramRuntimeConfig(): TelegramConfig {
  const telegram = loadConfig<TelegramConfig>('telegram.json')
  let batchingDelayMs = telegram.batchingDelayMs ?? 2500

  try {
    const settings = loadConfig<TelegramSettings>('settings.json')
    if (typeof settings.batchingDelayMs === 'number' && Number.isFinite(settings.batchingDelayMs) && settings.batchingDelayMs >= 0) {
      batchingDelayMs = settings.batchingDelayMs
    }
  } catch {
    // Fall back to telegram.json/defaults when settings are unavailable.
  }

  return {
    ...telegram,
    batchingDelayMs,
  }
}

/**
 * Telegram bot adapter that bridges Telegram messages to Agent Core
 */
export class TelegramBot {
  private bot: Bot
  private agentCore: AgentCore
  private db: Database | null
  private config: TelegramConfig
  private running = false
  private chatStates = new Map<string, ChatState>()
  private onQueueDepthChanged?: (queueDepth: number) => void
  private onChatEvent?: (event: TelegramChatEvent) => void

  constructor(options: TelegramBotOptions) {
    this.agentCore = options.agentCore
    this.db = options.db ?? null
    this.config = options.config ?? loadTelegramRuntimeConfig()
    this.onQueueDepthChanged = options.onQueueDepthChanged
    this.onChatEvent = options.onChatEvent

    if (!this.config.botToken) {
      throw new Error(
        'Telegram bot token not configured. Set botToken in /data/config/telegram.json or disable Telegram (enabled: false) for web-only mode.'
      )
    }

    this.bot = new Bot(this.config.botToken)
    this.setupHandlers()
    this.setupErrorHandler()
  }

  private getOrCreateChatState(chatKey: string): ChatState {
    const existing = this.chatStates.get(chatKey)
    if (existing) return existing

    const state: ChatState = {
      pendingBatch: null,
      queue: [],
      processing: false,
      abortRequested: false,
    }

    this.chatStates.set(chatKey, state)
    return state
  }

  private cleanupChatState(chatKey: string): void {
    const state = this.chatStates.get(chatKey)
    if (!state) return

    if (!state.processing && !state.pendingBatch && state.queue.length === 0) {
      this.chatStates.delete(chatKey)
    }
  }

  private emitQueueDepthChanged(): void {
    this.onQueueDepthChanged?.(this.getQueueDepth())
  }

  /**
   * Total queue depth across all chats, including pending batches and active work.
   */
  getQueueDepth(): number {
    let total = 0

    for (const state of this.chatStates.values()) {
      total += state.queue.length
      if (state.pendingBatch) total += 1
      if (state.processing) total += 1
    }

    return total
  }

  /**
   * Set up command and message handlers
   */
  private setupHandlers(): void {
    // /start command - welcome message
    this.bot.command('start', async (ctx) => {
      // Register the user but don't gate the welcome message
      this.ensureTelegramUser(ctx)

      const welcomeText = [
        '👋 *Welcome to OpenAgent!*',
        '',
        'I\'m your AI assistant. You can chat with me directly or use these commands:',
        '',
        '`/new` — Start a fresh conversation (summarizes & resets current session)',
        '`/start` — Show this welcome message',
        '`/stop` — Abort the current task and clear queued work',
        '',
        'Just send me a message to get started!',
      ].join('\n')

      await ctx.reply(welcomeText, { parse_mode: 'Markdown' })
    })

    // /new command - summarize + reset session
    this.bot.command('new', async (ctx) => {
      if (!await this.checkAuthorized(ctx)) return

      const userId = this.resolveUserId(ctx)

      try {
        const summary = await this.agentCore.handleNewCommand(userId)

        if (summary) {
          await ctx.reply('📝 Session summarized and saved. Starting fresh conversation!')
        } else {
          await ctx.reply('🔄 Starting fresh conversation!')
        }
      } catch (err) {
        console.error('Error handling /new command:', err)
        await ctx.reply('⚠️ Error resetting session. Please try again.')
      }
    })

    this.bot.command('stop', async (ctx) => {
      await this.handleKillSwitch(ctx)
    })

    this.bot.command('kill', async (ctx) => {
      await this.handleKillSwitch(ctx)
    })

    // Regular text messages
    this.bot.on('message:text', async (ctx) => {
      await this.handleMessage(ctx)
    })
  }

  /**
   * Ensure a telegram user record exists in the database.
   * Returns the row or null if no db is configured.
   */
  private ensureTelegramUser(ctx: Context): TelegramUserRow | null {
    if (!this.db || !ctx.from) return null

    const telegramId = String(ctx.from.id)
    const username = ctx.from.username ?? null
    const displayName = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || null

    const existing = this.db.prepare(
      'SELECT * FROM telegram_users WHERE telegram_id = ?'
    ).get(telegramId) as TelegramUserRow | undefined

    if (existing) {
      // Update username/display name if changed
      if (existing.telegram_username !== username || existing.telegram_display_name !== displayName) {
        this.db.prepare(
          "UPDATE telegram_users SET telegram_username = ?, telegram_display_name = ?, updated_at = datetime('now') WHERE id = ?"
        ).run(username, displayName, existing.id)
      }
      // Refresh avatar if we don't have one yet
      if (!this.hasAvatarFile(telegramId)) {
        this.fetchAndSaveAvatar(ctx.from.id).catch(() => {})
      }
      return existing
    }

    // Insert new pending user
    const result = this.db.prepare(
      'INSERT INTO telegram_users (telegram_id, telegram_username, telegram_display_name, status) VALUES (?, ?, ?, ?)'
    ).run(telegramId, username, displayName, 'pending')

    console.log(`[telegram] New user registered as pending: ${username ?? displayName ?? telegramId}`)

    // Fetch avatar in the background (don't block registration)
    this.fetchAndSaveAvatar(ctx.from.id).catch(() => {})

    return this.db.prepare(
      'SELECT * FROM telegram_users WHERE id = ?'
    ).get(result.lastInsertRowid) as TelegramUserRow
  }

  /**
   * Check if an avatar file exists for a given telegram user.
   */
  private hasAvatarFile(telegramId: string): boolean {
    const avatarDir = path.join(process.env.DATA_DIR ?? '/data', 'avatars')
    try {
      const files = fs.readdirSync(avatarDir)
      return files.some(f => f.startsWith(`telegram-${telegramId}.`))
    } catch {
      return false
    }
  }

  /**
   * Fetch a user's Telegram profile photo and save it locally.
   */
  private async fetchAndSaveAvatar(telegramId: number): Promise<void> {
    try {
      const photos = await this.bot.api.getUserProfilePhotos(telegramId, { limit: 1 })
      if (!photos.total_count || !photos.photos[0]?.length) return

      // Pick the smallest size that's at least 160px (good for avatars)
      const sizes = photos.photos[0]
      const photo = sizes.find(s => s.width >= 160) ?? sizes[sizes.length - 1]

      const file = await this.bot.api.getFile(photo.file_id)
      if (!file.file_path) return

      const url = `https://api.telegram.org/file/bot${this.config.botToken}/${file.file_path}`
      const response = await fetch(url)
      if (!response.ok) return

      const avatarDir = path.join(process.env.DATA_DIR ?? '/data', 'avatars')
      fs.mkdirSync(avatarDir, { recursive: true })

      const ext = file.file_path.split('.').pop() ?? 'jpg'
      const avatarPath = path.join(avatarDir, `telegram-${telegramId}.${ext}`)
      const buffer = Buffer.from(await response.arrayBuffer())
      fs.writeFileSync(avatarPath, buffer)

      console.log(`[telegram] Avatar saved for user ${telegramId}`)
    } catch (err) {
      console.warn(`[telegram] Could not fetch avatar for ${telegramId}:`, (err as Error).message)
    }
  }

  /**
   * Check if a telegram user is authorized. If not, sends a status message.
   * Returns true if the user may proceed.
   */
  private async checkAuthorized(ctx: Context): Promise<boolean> {
    if (!this.db) return true // No db = no access control

    const user = this.ensureTelegramUser(ctx)
    if (!user) return true

    if (user.status === 'approved') return true

    if (user.status === 'pending') {
      await this.safeSendMessage(ctx, '⏳ Your access request has been sent to the administrator. Please wait for approval.')
      return false
    }

    // rejected — silently ignore
    return false
  }

  /**
   * Resolve the user ID for session management.
   * If the telegram user is linked to an OpenAgent user, use that user's ID
   * in the same format as the web backend (plain string number).
   */
  private resolveUserId(ctx: Context): string {
    if (!this.db || !ctx.from) return getUserId(ctx)

    const telegramId = String(ctx.from.id)
    const row = this.db.prepare(
      'SELECT user_id FROM telegram_users WHERE telegram_id = ? AND status = ?'
    ).get(telegramId, 'approved') as { user_id: number | null } | undefined

    if (row?.user_id) {
      return String(row.user_id)
    }

    return getUserId(ctx)
  }

  /**
   * Resolve the numeric OpenAgent user ID for a Telegram user.
   * Returns null if unlinked.
   */
  private resolveNumericUserId(ctx: Context): number | null {
    if (!this.db || !ctx.from) return null

    const telegramId = String(ctx.from.id)
    const row = this.db.prepare(
      'SELECT user_id FROM telegram_users WHERE telegram_id = ? AND status = ?'
    ).get(telegramId, 'approved') as { user_id: number | null } | undefined

    return row?.user_id ?? null
  }

  /**
   * Get a display name for the Telegram user.
   */
  private getSenderName(ctx: Context): string {
    const from = ctx.from
    if (!from) return 'Unknown'
    if (from.username) return `@${from.username}`
    return [from.first_name, from.last_name].filter(Boolean).join(' ') || 'Unknown'
  }

  /**
   * Handle an incoming text message
   */
  private async handleMessage(ctx: Context): Promise<void> {
    const text = ctx.message?.text
    if (!text) return

    const normalizedCommand = normalizeCommand(text)
    if (STOP_COMMANDS.has(normalizedCommand)) {
      await this.handleKillSwitch(ctx)
      return
    }

    if (isHandledCommand(text)) {
      return
    }

    if (!await this.checkAuthorized(ctx)) return

    this.bufferMessage(ctx, text)
  }

  private bufferMessage(ctx: Context, text: string): void {
    const chatKey = getChatKey(ctx)
    const state = this.getOrCreateChatState(chatKey)

    if (state.pendingBatch) {
      clearTimeout(state.pendingBatch.timer)
      state.pendingBatch = {
        ctx,
        text: `${state.pendingBatch.text}\n${text}`,
        timer: this.createBatchTimer(chatKey),
      }
    } else {
      state.pendingBatch = {
        ctx,
        text,
        timer: this.createBatchTimer(chatKey),
      }
    }

    this.emitQueueDepthChanged()
  }

  private createBatchTimer(chatKey: string): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      void this.flushPendingBatch(chatKey)
    }, this.config.batchingDelayMs)
  }

  private async flushPendingBatch(chatKey: string): Promise<void> {
    const state = this.chatStates.get(chatKey)
    if (!state?.pendingBatch) return

    const batch = state.pendingBatch
    state.pendingBatch = null
    state.queue.push({ ctx: batch.ctx, text: batch.text })
    this.emitQueueDepthChanged()

    await this.processQueue(chatKey)
  }

  private async processQueue(chatKey: string): Promise<void> {
    const state = this.chatStates.get(chatKey)
    if (!state || state.processing) return

    state.processing = true
    this.emitQueueDepthChanged()

    try {
      while (state.queue.length > 0) {
        const queuedMessage = state.queue.shift()!
        this.emitQueueDepthChanged()
        await this.processQueuedMessage(chatKey, queuedMessage)
      }
    } finally {
      state.processing = false
      state.abortRequested = false
      this.emitQueueDepthChanged()
      this.cleanupChatState(chatKey)
    }
  }

  private async processQueuedMessage(chatKey: string, queuedMessage: QueuedMessage): Promise<void> {
    const state = this.chatStates.get(chatKey)
    if (!state) return

    const { ctx, text } = queuedMessage
    const userId = this.resolveUserId(ctx)
    const numericUserId = this.resolveNumericUserId(ctx)
    const messageForAgent = `${formatUserContext(ctx)}${text}`
    const senderName = this.getSenderName(ctx)

    // Generate a session ID for chat_messages storage
    const sessionId = `telegram-${userId}-${Date.now()}`

    // Save user message to chat_messages (if linked to a web user)
    if (this.db && numericUserId) {
      this.db.prepare(
        'INSERT INTO chat_messages (session_id, user_id, role, content) VALUES (?, ?, ?, ?)'
      ).run(sessionId, numericUserId, 'user', text)
    }

    // Broadcast user message event
    this.onChatEvent?.({
      type: 'user_message',
      userId: numericUserId,
      sessionId,
      text,
      senderName,
    })

    try {
      // Send "typing" indicator
      await ctx.replyWithChatAction('typing')

      // Collect the full response from agent
      let fullResponse = ''

      // Set up a typing indicator interval (every 4 seconds)
      const typingInterval = setInterval(async () => {
        try {
          await ctx.replyWithChatAction('typing')
        } catch {
          // Ignore typing indicator errors
        }
      }, 4000)

      try {
        for await (const chunk of this.agentCore.sendMessage(userId, messageForAgent, 'telegram')) {
          if (state.abortRequested) break

          if (chunk.type === 'text' && chunk.text) {
            fullResponse += chunk.text
          }

          // Broadcast response chunks for cross-channel sync
          this.onChatEvent?.({
            type: chunk.type === 'done' ? 'done' : chunk.type,
            userId: numericUserId,
            sessionId,
            text: chunk.text,
            toolName: chunk.toolName,
            toolCallId: chunk.toolCallId,
            toolArgs: chunk.toolArgs,
            toolResult: chunk.toolResult,
            toolIsError: chunk.toolIsError,
          })
        }
      } finally {
        clearInterval(typingInterval)
      }

      if (!state.abortRequested && fullResponse.trim()) {
        await this.sendLongMessage(ctx, fullResponse.trim())
      }

      // Save assistant response to chat_messages (if linked to a web user)
      if (this.db && numericUserId && fullResponse.trim()) {
        this.db.prepare(
          'INSERT INTO chat_messages (session_id, user_id, role, content) VALUES (?, ?, ?, ?)'
        ).run(sessionId, numericUserId, 'assistant', fullResponse.trim())
      }
    } catch (err) {
      if (state.abortRequested) {
        return
      }

      console.error('Error processing Telegram message:', err)
      await this.safeSendMessage(ctx, '⚠️ Sorry, I encountered an error processing your message. Please try again.')
    }
  }

  private async handleKillSwitch(ctx: Context): Promise<void> {
    const chatKey = getChatKey(ctx)
    const state = this.getOrCreateChatState(chatKey)
    const hadActiveTask = state.processing
    const removedQueuedMessages = state.queue.length + (state.pendingBatch ? 1 : 0)

    if (state.pendingBatch) {
      clearTimeout(state.pendingBatch.timer)
      state.pendingBatch = null
    }

    state.queue = []
    state.abortRequested = hadActiveTask
    this.emitQueueDepthChanged()

    if (hadActiveTask) {
      try {
        this.agentCore.abort()
      } catch (err) {
        console.error('Error aborting Telegram task:', err)
      }
    }

    const confirmation = !hadActiveTask && removedQueuedMessages === 0
      ? 'Nothing to stop.'
      : removedQueuedMessages === 0
        ? 'Task aborted. No queued messages.'
        : `⛔ Aborted. ${removedQueuedMessages} messages removed from queue.`

    await this.safeSendMessage(ctx, confirmation)
    this.cleanupChatState(chatKey)
  }

  /**
   * Send a potentially long message, splitting if necessary
   */
  private async sendLongMessage(ctx: Context, text: string): Promise<void> {
    const parts = splitMessage(text)

    for (const part of parts) {
      await this.safeSendMessage(ctx, part)
    }
  }

  /**
   * Send a message with error handling for Telegram API issues
   */
  private async safeSendMessage(ctx: Context, text: string, retries = 2): Promise<void> {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        await ctx.reply(text)
        return
      } catch (err) {
        if (err instanceof GrammyError) {
          // Handle rate limiting
          if (err.error_code === 429) {
            const retryAfter = (err.parameters?.retry_after ?? 5) * 1000
            console.warn(`Telegram rate limited. Retrying after ${retryAfter}ms`)
            await sleep(retryAfter)
            continue
          }

          // Other Telegram API errors
          console.error(`Telegram API error (${err.error_code}): ${err.description}`)
        } else if (err instanceof HttpError) {
          console.error('Telegram network error:', err.message)
          if (attempt < retries) {
            await sleep(1000 * (attempt + 1))
            continue
          }
        }

        // If we've exhausted retries or it's a non-retriable error, give up
        if (attempt === retries) {
          console.error('Failed to send Telegram message after retries:', err)
        }
      }
    }
  }

  /**
   * Set up global error handler for the bot
   */
  private setupErrorHandler(): void {
    this.bot.catch((err) => {
      const ctx = err.ctx
      const e = err.error

      console.error(`Error while handling update ${ctx.update.update_id}:`)

      if (e instanceof GrammyError) {
        console.error(`Grammy error (${e.error_code}): ${e.description}`)
      } else if (e instanceof HttpError) {
        console.error('HTTP error:', e.message)
      } else {
        console.error('Unknown error:', e)
      }
    })
  }

  /**
   * Start the bot in polling mode
   */
  async start(): Promise<void> {
    if (this.running) {
      console.warn('Telegram bot is already running')
      return
    }

    try {
      // Verify the bot token by fetching bot info
      const me = await this.bot.api.getMe()
      console.log(`✅ Telegram bot connected: @${me.username} (${me.first_name})`)

      // Start polling
      this.running = true
      this.bot.start({
        onStart: () => {
          console.log('🤖 Telegram bot started in polling mode')
        },
        drop_pending_updates: true,
      })
    } catch (err) {
      this.running = false
      if (err instanceof GrammyError) {
        throw new Error(`Failed to start Telegram bot: ${err.description} (code ${err.error_code})`)
      }
      throw new Error(`Failed to start Telegram bot: ${(err as Error).message}`)
    }
  }

  /**
   * Stop the bot gracefully
   */
  async stop(): Promise<void> {
    if (!this.running) return

    this.running = false
    this.bot.stop()
    console.log('🛑 Telegram bot stopped')
  }

  /**
   * Check if the bot is currently running
   */
  isRunning(): boolean {
    return this.running
  }

  /**
   * Send a message directly to a Telegram chat by chat ID.
   * Used for notifications (e.g. approval messages).
   */
  async sendDirectMessage(chatId: string | number, text: string): Promise<boolean> {
    try {
      await this.bot.api.sendMessage(chatId, text)
      return true
    } catch (err) {
      console.error(`[telegram] Failed to send direct message to ${chatId}:`, err)
      return false
    }
  }

  /**
   * Get the underlying grammy Bot instance (for advanced usage)
   */
  getBot(): Bot {
    return this.bot
  }
}

/**
 * Create a Telegram bot if configured, or return null for web-only mode.
 * Does not throw if Telegram is disabled or not configured.
 */
export function createTelegramBot(
  agentCore: AgentCore,
  db?: Database,
  onChatEvent?: (event: TelegramChatEvent) => void,
): TelegramBot | null {
  try {
    const config = loadTelegramRuntimeConfig()

    if (!config.enabled) {
      console.log('ℹ️  Telegram bot disabled in config (enabled: false). Running in web-only mode.')
      return null
    }

    if (!config.botToken) {
      console.log('ℹ️  No Telegram bot token configured. Running in web-only mode.')
      return null
    }

    return new TelegramBot({ agentCore, db, config, onChatEvent })
  } catch {
    console.log('ℹ️  Telegram config not found. Running in web-only mode.')
    return null
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
