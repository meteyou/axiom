import fs from 'node:fs'
import path from 'node:path'
import { Bot, GrammyError, HttpError, InputFile } from 'grammy'
import type { Context } from 'grammy'
import type { AgentCore, Database } from '@axiom/core'
import { loadConfig, saveUpload, serializeUploadsMetadata, parseUploadsMetadata, loadSttSettings, transcribeAudio, extractUploadsFromToolResult } from '@axiom/core'
import type { UploadDescriptor } from '@axiom/core'

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
  type: 'user_message' | 'text' | 'thinking' | 'tool_call_start' | 'tool_call_end' | 'done' | 'error' | 'attachment'
  /** Axiom user ID (integer) — only set for linked users */
  userId: number | null
  /** Session ID used for chat_messages */
  sessionId: string
  /** Text content */
  text?: string
  /** Streamed thinking/reasoning delta (for `type: 'thinking'`) */
  thinking?: string
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
  /** Uploaded file attached to the current assistant turn (for type='attachment') */
  attachment?: UploadDescriptor
  /**
   * Excerpt of the message the user replied to in Telegram (truncated to 500 chars).
   * Forwarded to the web UI so it can render a quote bubble above the user
   * message. Absent for non-reply messages.
   */
  replyContext?: string
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
  attachments?: UploadDescriptor[]
  /**
   * Plain-text excerpt of the message the user replied to (`reply_to_message`),
   * already truncated to REPLY_CONTEXT_MAX_LENGTH. Present only when the incoming
   * Telegram update carried a `reply_to_message` with extractable text/caption.
   * Used to:
   *   1. wrap the agent-facing prompt with `<reply-context>…</reply-context>`,
   *   2. persist alongside the user's message in `chat_messages.metadata` so the
   *      web UI can render a quote bubble on reload,
   *   3. ship to live web clients via the `user_message` chat event.
   */
  replyContext?: string
}

interface PendingBatch {
  ctx: Context
  text: string
  /** Reply context of the first message in the batch that carried one. */
  replyContext?: string
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

/**
 * Maximum number of characters kept from a replied-to message. Longer texts are
 * truncated with a trailing ellipsis (U+2026) before being stored / forwarded.
 */
const REPLY_CONTEXT_MAX_LENGTH = 500

/**
 * Extract the plain-text excerpt from a Telegram `reply_to_message`, if any.
 * Returns the truncated text (<=500 chars, trailing `…` when truncated) or
 * `undefined` for non-text replies (stickers, voice without caption, …).
 */
export function extractReplyContext(replyTo: unknown): string | undefined {
  if (!replyTo || typeof replyTo !== 'object') return undefined
  const r = replyTo as { text?: unknown; caption?: unknown }
  const raw = (typeof r.text === 'string' && r.text)
    || (typeof r.caption === 'string' && r.caption)
    || ''
  if (!raw) return undefined
  return raw.length > REPLY_CONTEXT_MAX_LENGTH
    ? raw.slice(0, REPLY_CONTEXT_MAX_LENGTH) + '\u2026'
    : raw
}

/**
 * Build the agent-facing prompt string for a Telegram turn. When `replyContext`
 * is present the original user text is prefixed with a `<reply-context>…</reply-context>`
 * wrapper on its own line so the model can see what the user replied to without
 * confusing it with the user's own words. The DB-persisted `content` field
 * stores the user's original text unchanged — the wrapper lives only in the
 * agent-facing string.
 */
export function buildAgentMessage(text: string, replyContext?: string): string {
  if (!replyContext) return text
  return `<reply-context>${replyContext}</reply-context>\n${text}`
}
const STOP_COMMANDS = new Set(['/stop', '/kill'])

/**
 * Convert standard Markdown to Telegram-compatible HTML.
 * Handles: bold, italic, code, code blocks, links, and escapes HTML entities.
 * Falls back gracefully — if conversion produces invalid HTML, caller should
 * fall back to plain text.
 */
function markdownToTelegramHtml(text: string): string {
  // Step 1: Extract code blocks and inline code to protect them from other transformations
  const codeBlocks: string[] = []
  const inlineCodes: string[] = []

  // Replace fenced code blocks with placeholders
  let result = text.replace(/```(\w+)?\n([\s\S]*?)```/g, (_match, lang, code) => {
    const escaped = escapeHtml(code.replace(/\n$/, ''))
    const block = lang ? `<pre><code class="language-${escapeHtml(lang)}">${escaped}</code></pre>` : `<pre>${escaped}</pre>`
    codeBlocks.push(block)
    return `\x00CODEBLOCK${codeBlocks.length - 1}\x00`
  })

  // Replace inline code with placeholders
  result = result.replace(/`([^`\n]+)`/g, (_match, code) => {
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`)
    return `\x00INLINECODE${inlineCodes.length - 1}\x00`
  })

  // Step 2: Escape HTML entities in the remaining text
  result = escapeHtml(result)

  // Step 3: Apply formatting conversions

  // Headings: # text → bold (Telegram has no heading support)
  result = result.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>')

  // Blockquotes: > text → <blockquote>
  // Collect consecutive > lines into a single blockquote
  result = result.replace(/(?:^&gt;\s?(.*)$\n?)+/gm, (match) => {
    const lines = match.split('\n')
      .filter(line => line.startsWith('&gt;'))
      .map(line => line.replace(/^&gt;\s?/, ''))
    return `<blockquote>${lines.join('\n')}</blockquote>\n`
  })

  // Bold+Italic: ***text*** or ___text___
  result = result.replace(/\*\*\*(.+?)\*\*\*/g, '<b><i>$1</i></b>')
  result = result.replace(/___(.+?)___/g, '<b><i>$1</i></b>')

  // Bold: **text** or __text__
  result = result.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
  result = result.replace(/__(.+?)__/g, '<b>$1</b>')

  // Italic: *text* or _text_ (but not within words for underscores)
  result = result.replace(/(?<!\w)\*([^\n*]+?)\*(?!\w)/g, '<i>$1</i>')
  result = result.replace(/(?<!\w)_([^\n_]+?)_(?!\w)/g, '<i>$1</i>')

  // Strikethrough: ~~text~~
  result = result.replace(/~~(.+?)~~/g, '<s>$1</s>')

  // Links: [text](url)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')

  // Step 4: Restore code blocks and inline code.
  // NUL bytes (\x00) are used as placeholder sentinels because they cannot
  // appear in normal Telegram text, so the control characters are intentional.
  // eslint-disable-next-line no-control-regex
  result = result.replace(/\x00CODEBLOCK(\d+)\x00/g, (_match, idx) => codeBlocks[Number(idx)])
  // eslint-disable-next-line no-control-regex
  result = result.replace(/\x00INLINECODE(\d+)\x00/g, (_match, idx) => inlineCodes[Number(idx)])

  return result
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function telegramHtmlToPlainText(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

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
        '👋 *Welcome to Axiom!*',
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

    this.bot.on('message:text', async (ctx) => {
      await this.handleMessage(ctx)
    })

    this.bot.on('message:document', async (ctx) => {
      await this.handleIncomingAttachment(ctx, 'document')
    })

    this.bot.on('message:photo', async (ctx) => {
      await this.handleIncomingAttachment(ctx, 'photo')
    })

    this.bot.on('message:voice', async (ctx) => {
      await this.handleVoiceMessage(ctx)
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
   * If the telegram user is linked to an Axiom user, use that user's ID
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
   * Resolve the numeric Axiom user ID for a Telegram user.
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

    const replyContext = extractReplyContext(ctx.message?.reply_to_message)
    this.bufferMessage(ctx, text, replyContext)
  }

  private async downloadTelegramFile(fileId: string): Promise<{ buffer: Buffer; mimeType?: string }> {
    const file = await this.bot.api.getFile(fileId)
    if (!file.file_path) throw new Error('Missing Telegram file path')
    const url = `https://api.telegram.org/file/bot${this.config.botToken}/${file.file_path}`
    const response = await fetch(url)
    if (!response.ok) throw new Error('Failed to download Telegram file')
    return { buffer: Buffer.from(await response.arrayBuffer()) }
  }

  private async handleIncomingAttachment(ctx: Context, kind: 'document' | 'photo'): Promise<void> {
    if (!await this.checkAuthorized(ctx)) return

    const userId = this.resolveUserId(ctx)
    const numericUserId = this.resolveNumericUserId(ctx)
    const caption = ctx.msg?.caption?.trim() ?? ''
    // Resolve session ID from SessionManager (aligns chat_messages with session tracking)
    const smSession = this.agentCore.getSessionManager().getOrCreateSession(userId, 'telegram')
    const sessionId = smSession.id

    try {
      let upload
      if (kind === 'document' && ctx.message?.document) {
        const payload = await this.downloadTelegramFile(ctx.message.document.file_id)
        upload = saveUpload({
          buffer: payload.buffer,
          originalName: ctx.message.document.file_name ?? 'document',
          mimeType: ctx.message.document.mime_type ?? 'application/octet-stream',
          source: 'telegram',
          userId: numericUserId,
          sessionId,
        })
      } else if (kind === 'photo' && ctx.message?.photo?.length) {
        const photo = ctx.message.photo[ctx.message.photo.length - 1]
        const payload = await this.downloadTelegramFile(photo.file_id)
        upload = saveUpload({
          buffer: payload.buffer,
          originalName: 'telegram-photo.jpg',
          mimeType: 'image/jpeg',
          source: 'telegram',
          userId: numericUserId,
          sessionId,
        })
      }

      if (!upload) return

      const messageText = caption || upload.originalName

      if (this.db && numericUserId) {
        this.db.prepare('INSERT INTO chat_messages (session_id, user_id, role, content, metadata) VALUES (?, ?, ?, ?, ?)')
          .run(sessionId, numericUserId, 'user', messageText, serializeUploadsMetadata([upload]))
      }

      this.onChatEvent?.({ type: 'user_message', userId: numericUserId, sessionId, text: messageText, senderName: this.getSenderName(ctx) })

      // Route to agent for processing (same path as text messages)
      const chatKey = getChatKey(ctx)
      const state = this.getOrCreateChatState(chatKey)
      state.queue.push({ ctx, text: messageText, attachments: [upload] })
      this.emitQueueDepthChanged()
      await this.processQueue(chatKey)
    } catch (err) {
      console.error('Error handling Telegram attachment:', err)
      await this.safeSendMessage(ctx, '⚠️ Datei konnte nicht gespeichert werden.')
    }
  }

  private async handleVoiceMessage(ctx: Context): Promise<void> {
    if (!await this.checkAuthorized(ctx)) return

    // Check if STT is enabled — silently ignore voice messages when disabled
    const sttSettings = loadSttSettings()
    if (!sttSettings.enabled) return

    try {
      const voice = ctx.message?.voice
      if (!voice) return

      // Download OGG audio from Telegram
      const { buffer } = await this.downloadTelegramFile(voice.file_id)

      // Resolve language from settings: if "match", "auto", or empty, omit language param
      const settings = loadConfig<Record<string, unknown>>('settings.json')
      const settingsLanguage = (settings.language as string) ?? ''
      const autoLanguages = ['match', 'auto', '']
      const language = autoLanguages.includes(settingsLanguage.toLowerCase())
        ? undefined
        : settingsLanguage

      // Transcribe via core STT module
      const result = await transcribeAudio(buffer, { language, filename: 'audio.ogg' })
      const transcript = result.rewritten ?? result.transcript

      if (!transcript.trim()) {
        console.warn('[telegram] Voice transcription returned empty result')
        return
      }

      // Prefix with voice indicator and process as normal message
      const text = `🎤 Voice: ${transcript.trim()}`
      this.bufferMessage(ctx, text)
    } catch (err) {
      console.error('[telegram] Voice transcription error:', err)
      await this.safeSendMessage(ctx, '⚠️ Could not transcribe voice message. Please try again or send a text message.')
    }
  }

  private bufferMessage(ctx: Context, text: string, replyContext?: string): void {
    const chatKey = getChatKey(ctx)
    const state = this.getOrCreateChatState(chatKey)

    if (state.pendingBatch) {
      clearTimeout(state.pendingBatch.timer)
      state.pendingBatch = {
        ctx,
        text: `${state.pendingBatch.text}\n${text}`,
        // Keep the first reply context we saw in this batch; later messages in
        // the same batch don't usually come with their own reply and would
        // otherwise drop the context.
        replyContext: state.pendingBatch.replyContext ?? replyContext,
        timer: this.createBatchTimer(chatKey),
      }
    } else {
      state.pendingBatch = {
        ctx,
        text,
        replyContext,
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
    state.queue.push({ ctx: batch.ctx, text: batch.text, replyContext: batch.replyContext })
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

  private async sendUploadToTelegram(chatId: string | number, file: ReturnType<typeof parseUploadsMetadata>[number]): Promise<void> {
    const absolutePath = path.join(process.env.DATA_DIR ?? '/data', 'uploads', file.relativePath)
    if (!fs.existsSync(absolutePath)) {
      throw new Error(`Upload file not found: ${file.relativePath}`)
    }

    const inputFile = new InputFile(absolutePath, file.originalName)
    if (file.kind === 'image') {
      await this.bot.api.sendPhoto(chatId, inputFile)
    } else {
      await this.bot.api.sendDocument(chatId, inputFile)
    }
  }

  private async sendAssistantResponseToTelegram(chatId: string | number, text: string, uploads: ReturnType<typeof parseUploadsMetadata>): Promise<void> {
    for (const file of uploads) {
      try {
        await this.sendUploadToTelegram(chatId, file)
      } catch (err) {
        console.error(`[telegram] Failed to send assistant upload to ${chatId}:`, err)
      }
    }

    if (text.trim()) {
      await this.sendLongMessageToChatId(chatId, text.trim())
    }
  }

  private async sendLongMessageToChatId(chatId: string | number, text: string): Promise<void> {
    const parts = splitMessage(text)
    for (const part of parts) {
      await this.sendPlainOrFormatted(chatId, part)
    }
  }

  private async sendPlainOrFormatted(chatId: string | number, text: string): Promise<void> {
    const htmlText = markdownToTelegramHtml(text)
    try {
      await this.bot.api.sendMessage(chatId, htmlText, { parse_mode: 'HTML' })
    } catch {
      await this.bot.api.sendMessage(chatId, text)
    }
  }

  /**
   * Resolve the username from the users table for a linked Telegram user.
   * Returns null if unlinked or not found.
   */
  private resolveUsername(ctx: Context): string | null {
    if (!this.db || !ctx.from) return null

    const telegramId = String(ctx.from.id)
    const row = this.db.prepare(
      `SELECT u.username FROM users u
       JOIN telegram_users tu ON tu.user_id = u.id
       WHERE tu.telegram_id = ? AND tu.status = 'approved'`
    ).get(telegramId) as { username: string } | undefined

    return row?.username ?? null
  }

  /**
   * Check if this is a DM (private) chat as opposed to a group chat.
   */
  private isDMChat(ctx: Context): boolean {
    return ctx.chat?.type === 'private'
  }

  private async processQueuedMessage(chatKey: string, queuedMessage: QueuedMessage): Promise<void> {
    const state = this.chatStates.get(chatKey)
    if (!state) return

    const { ctx, text, attachments, replyContext } = queuedMessage
    const userId = this.resolveUserId(ctx)
    const numericUserId = this.resolveNumericUserId(ctx)
    // Agent sees the reply context wrapped as a pseudo-system hint on its own
    // line; the DB-stored `content` remains exactly what the user typed.
    const messageForAgent = buildAgentMessage(text, replyContext)
    const senderName = this.getSenderName(ctx)

    const isDM = this.isDMChat(ctx)

    // Resolve session ID from SessionManager (aligns chat_messages with session tracking)
    const smSession = this.agentCore.getSessionManager().getOrCreateSession(userId, 'telegram')
    const sessionId = smSession.id

    // Save user message to chat_messages (if linked to a web user)
    // Skip if this came from handleIncomingAttachment (already saved).
    // When a reply context is present we stash it in the metadata JSON blob so
    // the web UI can render a WhatsApp/Telegram-style quote bubble on reload.
    if (this.db && numericUserId && !attachments?.length) {
      const metadata = replyContext ? JSON.stringify({ replyContext }) : null
      this.db.prepare(
        'INSERT INTO chat_messages (session_id, user_id, role, content, metadata) VALUES (?, ?, ?, ?, ?)'
      ).run(sessionId, numericUserId, 'user', text, metadata)
    }

    // Broadcast user message event (skip if already broadcast by attachment handler)
    if (!attachments?.length) {
      this.onChatEvent?.({
        type: 'user_message',
        userId: numericUserId,
        sessionId,
        text,
        senderName,
        replyContext,
      })
    }

    try {
      // Send "typing" indicator
      await ctx.replyWithChatAction('typing')

      // Collect the full response from agent
      let fullResponse = ''
      // Uploads produced by tools during this turn (e.g. `send_file_to_user`).
      // These are:
      //   1. delivered to the Telegram chat as documents/photos right after
      //      the text response (see sendAssistantResponseToTelegram),
      //   2. merged into the saved assistant message's metadata so history
      //      rehydration surfaces them alongside the text,
      //   3. broadcast as `attachment` chat events so concurrently connected
      //      web tabs render the same download card.
      const assistantUploads: UploadDescriptor[] = []
      // Track pending tool calls to save input+output together
      const pendingToolCalls = new Map<string, { toolName: string; toolArgs: unknown }>()

      // Set up a typing indicator interval (every 4 seconds)
      const typingInterval = setInterval(async () => {
        try {
          await ctx.replyWithChatAction('typing')
        } catch {
          // Ignore typing indicator errors
        }
      }, 4000)

      try {
        const source = isDM ? 'telegram' : 'telegram-group'
        for await (const chunk of this.agentCore.sendMessage(userId, messageForAgent, source, attachments)) {
          if (state.abortRequested) break

          if (chunk.type === 'text' && chunk.text) {
            fullResponse += chunk.text
          }

          // Track tool call start
          if (chunk.type === 'tool_call_start' && chunk.toolCallId) {
            pendingToolCalls.set(chunk.toolCallId, {
              toolName: chunk.toolName ?? 'unknown',
              toolArgs: chunk.toolArgs,
            })
          }

          // Save completed tool call to DB
          if (chunk.type === 'tool_call_end' && chunk.toolCallId) {
            const pending = pendingToolCalls.get(chunk.toolCallId)
            const toolName = pending?.toolName ?? chunk.toolName ?? 'unknown'
            if (this.db && numericUserId) {
              const metadata = JSON.stringify({
                toolName,
                toolCallId: chunk.toolCallId,
                toolArgs: pending?.toolArgs ?? null,
                toolResult: chunk.toolResult ?? null,
                toolIsError: chunk.toolIsError ?? false,
              })
              this.db.prepare(
                'INSERT INTO chat_messages (session_id, user_id, role, content, metadata) VALUES (?, ?, ?, ?, ?)'
              ).run(sessionId, numericUserId, 'tool', `Tool: ${toolName}`, metadata)
            }
            pendingToolCalls.delete(chunk.toolCallId)

            // Harvest uploads produced by the tool (generic, not tool-name
            // specific) and fan them out to cross-channel listeners so
            // any concurrently-connected web tab also shows the card.
            const newUploads = extractUploadsFromToolResult(chunk.toolResult)
            for (const upload of newUploads) {
              assistantUploads.push(upload)
              this.onChatEvent?.({
                type: 'attachment',
                userId: numericUserId,
                sessionId,
                attachment: upload,
              })
            }
          }

          // Broadcast response chunks for cross-channel sync
          this.onChatEvent?.({
            type: chunk.type === 'done' ? 'done' : chunk.type,
            userId: numericUserId,
            sessionId,
            text: chunk.text,
            thinking: chunk.thinking,
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

      if (!state.abortRequested && (fullResponse.trim() || assistantUploads.length > 0)) {
        await this.sendAssistantResponseToTelegram(ctx.chat!.id, fullResponse, assistantUploads)
      }

      // Save assistant response to chat_messages (if linked to a web user).
      // Text-only responses get a plain row; if the turn also produced
      // attachments we persist them in metadata so history rehydration
      // surfaces the download card alongside the text.
      if (this.db && numericUserId && (fullResponse.trim() || assistantUploads.length > 0)) {
        const metadata = assistantUploads.length > 0
          ? serializeUploadsMetadata(assistantUploads)
          : null
        this.db.prepare(
          'INSERT INTO chat_messages (session_id, user_id, role, content, metadata) VALUES (?, ?, ?, ?, ?)'
        ).run(sessionId, numericUserId, 'assistant', fullResponse.trim(), metadata)
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
   * Send a message with error handling for Telegram API issues.
   * Attempts to send as HTML (converted from Markdown) first, then falls back to plain text.
   */
  private async safeSendMessage(ctx: Context, text: string, retries = 2): Promise<void> {
    // Try sending with HTML formatting first
    const htmlText = markdownToTelegramHtml(text)
    const attempts: Array<{ text: string; parseMode?: 'HTML' }> = [
      { text: htmlText, parseMode: 'HTML' },
      { text }, // fallback: plain text, no parse_mode
    ]

    for (const { text: msgText, parseMode } of attempts) {
      let succeeded = false
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          if (parseMode) {
            await ctx.reply(msgText, { parse_mode: parseMode })
          } else {
            await ctx.reply(msgText)
          }
          succeeded = true
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

            // Bad Request (parse error) — skip to plain text fallback
            if (err.error_code === 400 && parseMode) {
              console.warn(`Telegram HTML parse error, falling back to plain text: ${err.description}`)
              break
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
      if (succeeded) return
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
    try {
      await this.bot.stop()
    } catch (err) {
      // Ignore errors during stop (e.g. 409 Conflict when another instance started polling)
      console.warn('[telegram] Error during bot stop (ignored):', (err as Error).message)
    }
    console.log('🛑 Telegram bot stopped')
  }

  /**
   * Check if the bot is currently running
   */
  isRunning(): boolean {
    return this.running
  }

  private syncOutgoingMessageToWeb(chatId: string | number, text: string): void {
    if (!this.db) return

    const normalizedChatId = String(chatId)
    const row = this.db.prepare(
      'SELECT user_id FROM telegram_users WHERE telegram_id = ? AND status = ?'
    ).get(normalizedChatId, 'approved') as { user_id: number | null } | undefined

    const userId = row?.user_id ?? null
    if (!userId) return

    // Resolve session ID from SessionManager (aligns chat_messages with session tracking)
    const smSession = this.agentCore.getSessionManager().getOrCreateSession(String(userId), 'telegram')
    const sessionId = smSession.id

    try {
      this.db.prepare(
        'INSERT INTO chat_messages (session_id, user_id, role, content) VALUES (?, ?, ?, ?)'
      ).run(sessionId, userId, 'assistant', text)
    } catch (err) {
      console.error(`[telegram] Failed to persist outbound Telegram message for user ${userId}:`, err)
    }

    this.onChatEvent?.({
      type: 'text',
      userId,
      sessionId,
      text,
    })
    this.onChatEvent?.({
      type: 'done',
      userId,
      sessionId,
    })
  }

  /**
   * Send a message directly to a Telegram chat by chat ID.
   * Used for notifications (e.g. approval messages).
   */
  async sendDirectMessage(chatId: string | number, text: string): Promise<boolean> {
    try {
      await this.bot.api.sendMessage(chatId, text)
      this.syncOutgoingMessageToWeb(chatId, text)
      return true
    } catch (err) {
      console.error(`[telegram] Failed to send direct message to ${chatId}:`, err)
      return false
    }
  }

  /**
   * Send a task notification to a Telegram chat with HTML formatting.
   * Automatically splits long messages to stay within Telegram's 4096 char limit.
   * Used for proactive task result notifications.
   */
  async sendTaskNotification(chatId: string | number, html: string): Promise<boolean> {
    const parts = splitMessage(html)
    const plainFull = telegramHtmlToPlainText(html)

    for (const part of parts) {
      try {
        await this.bot.api.sendMessage(chatId, part, { parse_mode: 'HTML' })
      } catch {
        // Fallback to plain text if HTML parsing fails
        try {
          const plainPart = telegramHtmlToPlainText(part)
          await this.bot.api.sendMessage(chatId, plainPart)
        } catch (fallbackErr) {
          console.error(`[telegram] Failed to send task notification to ${chatId}:`, fallbackErr)
          return false
        }
      }
    }

    this.syncOutgoingMessageToWeb(chatId, plainFull)
    return true
  }

  /**
   * Get the Telegram chat ID for a given Axiom user ID.
   * Returns null if no linked & approved Telegram user exists.
   */
  getTelegramChatIdForUser(userId: number): string | null {
    if (!this.db) return null

    const row = this.db.prepare(
      'SELECT telegram_id FROM telegram_users WHERE user_id = ? AND status = ?'
    ).get(userId, 'approved') as { telegram_id: string } | undefined

    return row?.telegram_id ?? null
  }

  /**
   * Send a Markdown-formatted message to a Telegram chat.
   * Converts Markdown to Telegram HTML and sends with fallback to plain text.
   * Does NOT sync back to web chat (intended for task injection responses).
   */
  async sendFormattedMessage(chatId: string | number, markdown: string): Promise<boolean> {
    const parts = splitMessage(markdown)

    for (const part of parts) {
      try {
        const html = markdownToTelegramHtml(part)
        await this.bot.api.sendMessage(chatId, html, { parse_mode: 'HTML' })
      } catch {
        try {
          await this.bot.api.sendMessage(chatId, part)
        } catch (err) {
          console.error(`[telegram] Failed to send formatted message to ${chatId}:`, err)
          return false
        }
      }
    }

    return true
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
