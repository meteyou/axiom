/* eslint-disable @typescript-eslint/no-unsafe-function-type, @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AgentCore, ResponseChunk } from '@openagent/core'

// Mock grammy before importing the module under test
vi.mock('grammy', () => {
  const handlers: Map<string, Function> = new Map()
  const commandHandlers: Map<string, Function> = new Map()

  const mockApi = {
    getMe: vi.fn().mockResolvedValue({
      id: 123456,
      is_bot: true,
      first_name: 'TestBot',
      username: 'test_bot',
    }),
    sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
  }

  const MockBot = vi.fn().mockImplementation(() => ({
    api: mockApi,
    command: vi.fn((cmd: string, handler: Function) => {
      commandHandlers.set(cmd, handler)
    }),
    on: vi.fn((filter: string, handler: Function) => {
      handlers.set(filter, handler)
    }),
    catch: vi.fn(),
    start: vi.fn(({ onStart }: { onStart?: () => void }) => {
      onStart?.()
    }),
    stop: vi.fn(),
    _handlers: handlers,
    _commandHandlers: commandHandlers,
  }))

  return {
    Bot: MockBot,
    GrammyError: class GrammyError extends Error {
      error_code: number
      description: string
      parameters?: { retry_after?: number }
      constructor(message: string, error_code: number = 400, description: string = message) {
        super(message)
        this.error_code = error_code
        this.description = description
      }
    },
    HttpError: class HttpError extends Error {
      constructor(message: string) {
        super(message)
      }
    },
  }
})

// Mock @openagent/core
vi.mock('@openagent/core', () => ({
  loadConfig: vi.fn((filename: string) => {
    if (filename === 'settings.json') {
      return { batchingDelayMs: 2500 }
    }

    return {
      enabled: true,
      botToken: 'test-token-123',
      adminUserIds: [],
      pollingMode: true,
      webhookUrl: '',
      batchingDelayMs: 2500,
    }
  }),
}))

import { TelegramBot, createTelegramBot } from './bot.js'
import type { TelegramConfig } from './bot.js'
import { loadConfig } from '@openagent/core'

function createMockAgentCore(): AgentCore {
  return {
    sendMessage: vi.fn(),
    handleNewCommand: vi.fn(),
    resetSession: vi.fn(),
    abort: vi.fn(),
    getSessionManager: vi.fn(),
    refreshSystemPrompt: vi.fn(),
    getAgent: vi.fn(),
    dispose: vi.fn(),
  } as unknown as AgentCore
}

function createMockContext(overrides: Record<string, unknown> = {}) {
  return {
    from: {
      id: 12345,
      is_bot: false,
      first_name: 'John',
      last_name: 'Doe',
      username: 'johndoe',
    },
    chat: {
      id: 67890,
      type: 'private',
    },
    message: {
      text: 'Hello agent',
      message_id: 1,
    },
    reply: vi.fn().mockResolvedValue({}),
    replyWithChatAction: vi.fn().mockResolvedValue(true),
    ...overrides,
  }
}

async function* doneOnlyStream(): AsyncGenerator<ResponseChunk> {
  yield { type: 'done' }
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve()
  await vi.advanceTimersByTimeAsync(0)
  await Promise.resolve()
}

type MockHandler = (ctx: ReturnType<typeof createMockContext>) => Promise<void>
type MockBotInternals = {
  _handlers: Map<string, MockHandler>
  _commandHandlers: Map<string, MockHandler>
}

const defaultConfig: TelegramConfig = {
  enabled: true,
  botToken: 'test-token-123',
  adminUserIds: [],
  pollingMode: true,
  webhookUrl: '',
  batchingDelayMs: 2500,
}

describe('TelegramBot', () => {
  let agentCore: AgentCore

  beforeEach(() => {
    agentCore = createMockAgentCore()
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.mocked(loadConfig).mockImplementation((filename: string) => {
      if (filename === 'settings.json') {
        return { batchingDelayMs: 2500 }
      }

      return {
        enabled: true,
        botToken: 'test-token-123',
        adminUserIds: [],
        pollingMode: true,
        webhookUrl: '',
        batchingDelayMs: 2500,
      }
    })
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  describe('constructor', () => {
    it('throws when no bot token provided', () => {
      expect(() => new TelegramBot({
        agentCore,
        config: { ...defaultConfig, botToken: '' },
      })).toThrow('Telegram bot token not configured')
    })

    it('creates bot successfully with valid config', () => {
      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      expect(bot).toBeDefined()
      expect(bot.isRunning()).toBe(false)
      expect(bot.getQueueDepth()).toBe(0)
    })
  })

  describe('start', () => {
    it('verifies token and starts polling', async () => {
      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      await bot.start()

      expect(bot.isRunning()).toBe(true)
      const underlying = bot.getBot() as any
      expect(underlying.api.getMe).toHaveBeenCalled()
      expect(underlying.start).toHaveBeenCalled()
    })
  })

  describe('stop', () => {
    it('stops the bot', async () => {
      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      await bot.start()
      await bot.stop()

      expect(bot.isRunning()).toBe(false)
    })
  })

  describe('/start command', () => {
    it('sends welcome message', async () => {
      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      const underlying = bot.getBot() as unknown as MockBotInternals
      const handler = underlying._commandHandlers.get('start')!

      const ctx = createMockContext()
      await handler(ctx)

      expect(ctx.reply).toHaveBeenCalledTimes(1)
      const msg = ctx.reply.mock.calls[0][0] as string
      expect(msg).toContain('Welcome to OpenAgent')
      expect(msg).toContain('/new')
      expect(msg).toContain('/start')
      expect(msg).toContain('/stop')
    })
  })

  describe('/new command', () => {
    it('delegates to agent core handleNewCommand', async () => {
      vi.mocked(agentCore.handleNewCommand).mockResolvedValue('Session summary here')

      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      const underlying = bot.getBot() as unknown as MockBotInternals
      const handler = underlying._commandHandlers.get('new')!

      const ctx = createMockContext()
      await handler(ctx)

      expect(agentCore.handleNewCommand).toHaveBeenCalledWith('telegram-12345')
      expect(ctx.reply).toHaveBeenCalledWith('📝 Session summarized and saved. Starting fresh conversation!')
    })

    it('sends fresh conversation message when no summary', async () => {
      vi.mocked(agentCore.handleNewCommand).mockResolvedValue(null)

      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      const underlying = bot.getBot() as unknown as MockBotInternals
      const handler = underlying._commandHandlers.get('new')!

      const ctx = createMockContext()
      await handler(ctx)

      expect(ctx.reply).toHaveBeenCalledWith('🔄 Starting fresh conversation!')
    })

    it('handles errors gracefully', async () => {
      vi.mocked(agentCore.handleNewCommand).mockRejectedValue(new Error('db error'))

      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      const underlying = bot.getBot() as unknown as MockBotInternals
      const handler = underlying._commandHandlers.get('new')!

      const ctx = createMockContext()
      await handler(ctx)

      expect(ctx.reply).toHaveBeenCalledWith('⚠️ Error resetting session. Please try again.')
    })
  })

  describe('message batching', () => {
    it('concatenates two messages sent within the batching window', async () => {
      vi.mocked(agentCore.sendMessage).mockReturnValue(doneOnlyStream())

      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      const underlying = bot.getBot() as unknown as MockBotInternals
      const handler = underlying._handlers.get('message:text')!

      const first = createMockContext({ message: { text: 'Hello', message_id: 1 } })
      const second = createMockContext({ message: { text: 'world', message_id: 2 } })

      await handler(first)
      await vi.advanceTimersByTimeAsync(2000)
      await handler(second)

      expect(agentCore.sendMessage).not.toHaveBeenCalled()
      expect(bot.getQueueDepth()).toBe(1)

      await vi.advanceTimersByTimeAsync(2499)
      expect(agentCore.sendMessage).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1)
      expect(agentCore.sendMessage).toHaveBeenCalledTimes(1)
      expect(agentCore.sendMessage).toHaveBeenCalledWith(
        'telegram-12345',
        'Hello\nworld',
        'telegram',
        undefined
      )
    })

    it('resets the batching timer on each new message from the same chat', async () => {
      vi.mocked(agentCore.sendMessage).mockReturnValue(doneOnlyStream())

      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      const underlying = bot.getBot() as unknown as MockBotInternals
      const handler = underlying._handlers.get('message:text')!

      await handler(createMockContext({ message: { text: 'Part 1', message_id: 1 } }))
      await vi.advanceTimersByTimeAsync(2000)
      await handler(createMockContext({ message: { text: 'Part 2', message_id: 2 } }))
      await vi.advanceTimersByTimeAsync(2000)

      expect(agentCore.sendMessage).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(500)
      expect(agentCore.sendMessage).toHaveBeenCalledTimes(1)
    })

    it('uses the batching delay from settings.json when created via config loading', async () => {
      vi.mocked(loadConfig).mockImplementation((filename: string) => {
        if (filename === 'settings.json') {
          return { batchingDelayMs: 4000 }
        }

        return {
          enabled: true,
          botToken: 'test-token-123',
          adminUserIds: [],
          pollingMode: true,
          webhookUrl: '',
          batchingDelayMs: 2500,
        }
      })
      vi.mocked(agentCore.sendMessage).mockReturnValue(doneOnlyStream())

      const bot = createTelegramBot(agentCore)!
      const underlying = bot.getBot() as unknown as MockBotInternals
      const handler = underlying._handlers.get('message:text')!

      await handler(createMockContext({ message: { text: 'Delayed', message_id: 1 } }))
      await vi.advanceTimersByTimeAsync(3999)
      expect(agentCore.sendMessage).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1)
      expect(agentCore.sendMessage).toHaveBeenCalledTimes(1)
    })

    it('fires the batch only after the silence period expires', async () => {
      vi.mocked(agentCore.sendMessage).mockReturnValue(doneOnlyStream())

      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      const underlying = bot.getBot() as unknown as MockBotInternals
      const handler = underlying._handlers.get('message:text')!

      await handler(createMockContext({ message: { text: 'Wait for silence', message_id: 1 } }))
      await vi.advanceTimersByTimeAsync(2499)
      expect(agentCore.sendMessage).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1)
      expect(agentCore.sendMessage).toHaveBeenCalledTimes(1)
    })
  })

  describe('message queue', () => {
    it('processes queued batches FIFO, one at a time', async () => {
      let releaseFirst!: () => void
      const firstDone = new Promise<void>((resolve) => {
        releaseFirst = resolve
      })

      async function* firstStream(): AsyncGenerator<ResponseChunk> {
        yield { type: 'text', text: 'First response' }
        await firstDone
        yield { type: 'done' }
      }

      async function* secondStream(): AsyncGenerator<ResponseChunk> {
        yield { type: 'text', text: 'Second response' }
        yield { type: 'done' }
      }

      vi.mocked(agentCore.sendMessage)
        .mockReturnValueOnce(firstStream())
        .mockReturnValueOnce(secondStream())

      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      const underlying = bot.getBot() as unknown as MockBotInternals
      const handler = underlying._handlers.get('message:text')!

      const first = createMockContext({ message: { text: 'First task', message_id: 1 } })
      const second = createMockContext({ message: { text: 'Second task', message_id: 2 } })

      await handler(first)
      await vi.advanceTimersByTimeAsync(2500)
      expect(agentCore.sendMessage).toHaveBeenCalledTimes(1)
      expect(bot.getQueueDepth()).toBe(1)

      await handler(second)
      await vi.advanceTimersByTimeAsync(2500)
      expect(agentCore.sendMessage).toHaveBeenCalledTimes(1)
      expect(bot.getQueueDepth()).toBe(2)

      releaseFirst()
      await flushAsyncWork()
      await flushAsyncWork()

      expect(agentCore.sendMessage).toHaveBeenCalledTimes(2)
      expect(vi.mocked(agentCore.sendMessage).mock.calls.map((call) => call[1])).toEqual([
        'First task',
        'Second task',
      ])
    })
  })

  describe('kill switch', () => {
    it('/stop aborts the current task, flushes queued work, and reports the removed count', async () => {
      let releaseFirst!: () => void
      const firstDone = new Promise<void>((resolve) => {
        releaseFirst = resolve
      })

      async function* firstStream(): AsyncGenerator<ResponseChunk> {
        yield { type: 'text', text: 'Working...' }
        await firstDone
        yield { type: 'done' }
      }

      vi.mocked(agentCore.sendMessage).mockReturnValue(firstStream())

      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      const underlying = bot.getBot() as unknown as MockBotInternals
      const messageHandler = underlying._handlers.get('message:text')!
      const stopHandler = underlying._commandHandlers.get('stop')!

      await messageHandler(createMockContext({ message: { text: 'Run task', message_id: 1 } }))
      await vi.advanceTimersByTimeAsync(2500)
      expect(agentCore.sendMessage).toHaveBeenCalledTimes(1)

      await messageHandler(createMockContext({ message: { text: 'Queued task', message_id: 2 } }))
      await vi.advanceTimersByTimeAsync(2500)
      expect(bot.getQueueDepth()).toBe(2)
      expect(agentCore.sendMessage).toHaveBeenCalledTimes(1)

      const stopCtx = createMockContext({ message: { text: '/stop', message_id: 3 } })
      await stopHandler(stopCtx)

      expect(agentCore.abort).toHaveBeenCalledTimes(1)
      expect(stopCtx.reply).toHaveBeenCalledWith('⛔ Aborted. 1 messages removed from queue.', { parse_mode: 'HTML' })
      expect(bot.getQueueDepth()).toBe(1)

      releaseFirst()
      await flushAsyncWork()
      await flushAsyncWork()
      expect(agentCore.sendMessage).toHaveBeenCalledTimes(1)
      expect(bot.getQueueDepth()).toBe(0)
    })

    it('/kill behaves as an alias for /stop', async () => {
      let releaseTask!: () => void
      const blocked = new Promise<void>((resolve) => {
        releaseTask = resolve
      })

      async function* blockedStream(): AsyncGenerator<ResponseChunk> {
        yield { type: 'text', text: 'Still working' }
        await blocked
        yield { type: 'done' }
      }

      vi.mocked(agentCore.sendMessage).mockReturnValue(blockedStream())

      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      const underlying = bot.getBot() as unknown as MockBotInternals
      const messageHandler = underlying._handlers.get('message:text')!
      const killHandler = underlying._commandHandlers.get('kill')!

      await messageHandler(createMockContext({ message: { text: 'Task', message_id: 1 } }))
      await vi.advanceTimersByTimeAsync(2500)

      const killCtx = createMockContext({ message: { text: '/kill', message_id: 2 } })
      await killHandler(killCtx)

      expect(agentCore.abort).toHaveBeenCalledTimes(1)
      expect(killCtx.reply).toHaveBeenCalledWith('Task aborted. No queued messages.', { parse_mode: 'HTML' })

      releaseTask()
      await flushAsyncWork()
      await flushAsyncWork()
      expect(bot.getQueueDepth()).toBe(0)
    })

    it('returns "Nothing to stop." when no task is running and nothing is queued', async () => {
      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      const underlying = bot.getBot() as unknown as MockBotInternals
      const stopHandler = underlying._commandHandlers.get('stop')!

      const ctx = createMockContext({ message: { text: '/stop', message_id: 1 } })
      await stopHandler(ctx)

      expect(agentCore.abort).not.toHaveBeenCalled()
      expect(ctx.reply).toHaveBeenCalledWith('Nothing to stop.', { parse_mode: 'HTML' })
      expect(bot.getQueueDepth()).toBe(0)
    })

    it('returns "Task aborted. No queued messages." when only the current task is running', async () => {
      let releaseTask!: () => void
      const blocked = new Promise<void>((resolve) => {
        releaseTask = resolve
      })

      async function* blockedStream(): AsyncGenerator<ResponseChunk> {
        yield { type: 'text', text: 'Working' }
        await blocked
        yield { type: 'done' }
      }

      vi.mocked(agentCore.sendMessage).mockReturnValue(blockedStream())

      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      const underlying = bot.getBot() as unknown as MockBotInternals
      const messageHandler = underlying._handlers.get('message:text')!
      const stopHandler = underlying._commandHandlers.get('stop')!

      await messageHandler(createMockContext({ message: { text: 'Only task', message_id: 1 } }))
      await vi.advanceTimersByTimeAsync(2500)

      const stopCtx = createMockContext({ message: { text: '/stop', message_id: 2 } })
      await stopHandler(stopCtx)

      expect(agentCore.abort).toHaveBeenCalledTimes(1)
      expect(stopCtx.reply).toHaveBeenCalledWith('Task aborted. No queued messages.', { parse_mode: 'HTML' })

      releaseTask()
      await flushAsyncWork()
      await flushAsyncWork()
    })
  })

  describe('message handling', () => {
    it('routes messages to agent core with user context after batching', async () => {
      async function* mockStream(): AsyncGenerator<ResponseChunk> {
        yield { type: 'text', text: 'Hello ' }
        yield { type: 'text', text: 'human!' }
        yield { type: 'done' }
      }
      vi.mocked(agentCore.sendMessage).mockReturnValue(mockStream())

      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      const underlying = bot.getBot() as unknown as MockBotInternals
      const handler = underlying._handlers.get('message:text')!

      const ctx = createMockContext()
      await handler(ctx)
      await vi.advanceTimersByTimeAsync(2500)

      expect(agentCore.sendMessage).toHaveBeenCalledWith(
        'telegram-12345',
        'Hello agent',
        'telegram',
        undefined
      )
      const botApi = (bot.getBot() as any).api
      expect(botApi.sendMessage).toHaveBeenCalledWith(67890, 'Hello human!', { parse_mode: 'HTML' })
    })

    it('handles empty responses gracefully', async () => {
      vi.mocked(agentCore.sendMessage).mockReturnValue(doneOnlyStream())

      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      const underlying = bot.getBot() as unknown as MockBotInternals
      const handler = underlying._handlers.get('message:text')!

      const ctx = createMockContext()
      await handler(ctx)
      await vi.advanceTimersByTimeAsync(2500)

      expect(ctx.reply).not.toHaveBeenCalled()
    })

    it('handles agent errors gracefully', async () => {
      vi.mocked(agentCore.sendMessage).mockImplementation(() => {
        throw new Error('agent failed')
      })

      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      const underlying = bot.getBot() as unknown as MockBotInternals
      const handler = underlying._handlers.get('message:text')!

      const ctx = createMockContext()
      await handler(ctx)
      await vi.advanceTimersByTimeAsync(2500)

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('encountered an error'),
        { parse_mode: 'HTML' }
      )
    })
  })

  describe('DM vs group chat', () => {
    it('sends telegram source for DM (private) chats', async () => {
      vi.mocked(agentCore.sendMessage).mockReturnValue(doneOnlyStream())

      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      const underlying = bot.getBot() as unknown as MockBotInternals
      const handler = underlying._handlers.get('message:text')!

      const ctx = createMockContext({
        chat: { id: 67890, type: 'private' },
        message: { text: 'Hello DM', message_id: 1 },
      })
      await handler(ctx)
      await vi.advanceTimersByTimeAsync(2500)

      expect(agentCore.sendMessage).toHaveBeenCalledWith(
        'telegram-12345',
        'Hello DM',
        'telegram',
        undefined
      )
    })

    it('sends telegram-group source for group chats', async () => {
      vi.mocked(agentCore.sendMessage).mockReturnValue(doneOnlyStream())

      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      const underlying = bot.getBot() as unknown as MockBotInternals
      const handler = underlying._handlers.get('message:text')!

      const ctx = createMockContext({
        chat: { id: 67890, type: 'group' },
        message: { text: 'Hello group', message_id: 1 },
      })
      await handler(ctx)
      await vi.advanceTimersByTimeAsync(2500)

      expect(agentCore.sendMessage).toHaveBeenCalledWith(
        'telegram-12345',
        'Hello group',
        'telegram-group',
        undefined
      )
    })

    it('sends telegram-group source for supergroup chats', async () => {
      vi.mocked(agentCore.sendMessage).mockReturnValue(doneOnlyStream())

      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      const underlying = bot.getBot() as unknown as MockBotInternals
      const handler = underlying._handlers.get('message:text')!

      const ctx = createMockContext({
        chat: { id: 67890, type: 'supergroup' },
        message: { text: 'Hello supergroup', message_id: 1 },
      })
      await handler(ctx)
      await vi.advanceTimersByTimeAsync(2500)

      expect(agentCore.sendMessage).toHaveBeenCalledWith(
        'telegram-12345',
        'Hello supergroup',
        'telegram-group',
        undefined
      )
    })
  })

  describe('message splitting', () => {
    it('splits messages longer than 4096 chars', async () => {
      const longText = 'A'.repeat(5000)
      async function* mockStream(): AsyncGenerator<ResponseChunk> {
        yield { type: 'text', text: longText }
        yield { type: 'done' }
      }
      vi.mocked(agentCore.sendMessage).mockReturnValue(mockStream())

      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      const underlying = bot.getBot() as unknown as MockBotInternals
      const handler = underlying._handlers.get('message:text')!

      const ctx = createMockContext()
      await handler(ctx)
      await vi.advanceTimersByTimeAsync(2500)

      const botApi = (bot.getBot() as any).api
      expect(botApi.sendMessage.mock.calls.length).toBeGreaterThanOrEqual(2)

      const allText = botApi.sendMessage.mock.calls.map((c: unknown[]) => c[1] as string).join('')
      expect(allText.length).toBe(5000)
    })
  })
})

describe('createTelegramBot', () => {
  let agentCore: AgentCore

  beforeEach(() => {
    agentCore = createMockAgentCore()
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('returns null when disabled', () => {
    vi.mocked(loadConfig).mockImplementation((filename: string) => {
      if (filename === 'settings.json') {
        return { batchingDelayMs: 2500 }
      }

      return {
        enabled: false,
        botToken: 'some-token',
        adminUserIds: [],
        pollingMode: true,
        webhookUrl: '',
        batchingDelayMs: 2500,
      }
    })

    const result = createTelegramBot(agentCore)
    expect(result).toBeNull()
  })

  it('returns null when no token', () => {
    vi.mocked(loadConfig).mockImplementation((filename: string) => {
      if (filename === 'settings.json') {
        return { batchingDelayMs: 2500 }
      }

      return {
        enabled: true,
        botToken: '',
        adminUserIds: [],
        pollingMode: true,
        webhookUrl: '',
        batchingDelayMs: 2500,
      }
    })

    const result = createTelegramBot(agentCore)
    expect(result).toBeNull()
  })

  it('returns TelegramBot instance when configured', () => {
    vi.mocked(loadConfig).mockImplementation((filename: string) => {
      if (filename === 'settings.json') {
        return { batchingDelayMs: 2500 }
      }

      return {
        enabled: true,
        botToken: 'valid-token',
        adminUserIds: [],
        pollingMode: true,
        webhookUrl: '',
        batchingDelayMs: 2500,
      }
    })

    const result = createTelegramBot(agentCore)
    expect(result).toBeInstanceOf(TelegramBot)
  })

  it('returns null when config load fails', () => {
    vi.mocked(loadConfig).mockImplementation(() => {
      throw new Error('file not found')
    })

    const result = createTelegramBot(agentCore)
    expect(result).toBeNull()
  })
})
