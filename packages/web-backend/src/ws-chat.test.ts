import { describe, it, expect, vi } from 'vitest'
import http from 'node:http'
import { WebSocket } from 'ws'
import { initDatabase } from '@axiom/core'
import type { AgentCore, ResponseChunk } from '@axiom/core'
import { createApp } from './app.js'
import { generateAccessToken } from './auth.js'
import { setupWebSocketChat } from './ws-chat.js'
import { ChatEventBus } from './chat-event-bus.js'

interface BufferedWs {
  ws: WebSocket
  waitForMessage: () => Promise<Record<string, unknown>>
  expectNoMessageWithin: (ms: number) => Promise<void>
}

function connectWs(port: number, token: string): Promise<BufferedWs> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws/chat?token=${token}`)
    const messages: Record<string, unknown>[] = []
    let pendingResolve: ((msg: Record<string, unknown>) => void) | null = null

    ws.on('message', (data) => {
      const parsed = JSON.parse(data.toString()) as Record<string, unknown>
      if (pendingResolve) {
        const current = pendingResolve
        pendingResolve = null
        current(parsed)
      } else {
        messages.push(parsed)
      }
    })

    ws.on('open', () => {
      resolve({
        ws,
        waitForMessage: () => {
          if (messages.length > 0) {
            return Promise.resolve(messages.shift()!)
          }

          return new Promise((res) => {
            pendingResolve = res
          })
        },
        expectNoMessageWithin: async (ms: number) => {
          if (messages.length > 0) {
            throw new Error(`Expected no queued message, got: ${JSON.stringify(messages[0])}`)
          }

          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, ms)
            pendingResolve = (msg) => {
              clearTimeout(timer)
              pendingResolve = null
              reject(new Error(`Expected no message within ${ms}ms, got: ${JSON.stringify(msg)}`))
            }
          })
        },
      })
    })

    ws.on('error', reject)
  })
}

describe('setupWebSocketChat kill switch', () => {
  it('aborts the active agent task when /stop is sent from web chat', async () => {
    const db = initDatabase(':memory:')
    let releaseTask!: () => void
    const blocked = new Promise<void>((resolve) => {
      releaseTask = resolve
    })

    const mockSessionManager = {
      getOrCreateSession: vi.fn(() => ({ id: 'session-1-mock', userId: '1', source: 'web', startedAt: Date.now(), lastActivity: Date.now(), messageCount: 0, summaryWritten: false, restored: false })),
    }
    const agentCore = {
      sendMessage: vi.fn(async function* (): AsyncGenerator<ResponseChunk> {
        yield { type: 'text', text: 'Working...' }
        await blocked
        yield { type: 'done' }
      }),
      abort: vi.fn(),
      resetSession: vi.fn(),
      getSessionManager: vi.fn(() => mockSessionManager),
    } as unknown as AgentCore

    const app = createApp({ db })
    const server = http.createServer(app)
    const { wss } = setupWebSocketChat(server, db, agentCore)

    await new Promise<void>((resolve) => server.listen(0, resolve))
    const port = (server.address() as { port: number }).port
    const token = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })

    try {
      const { ws, waitForMessage } = await connectWs(port, token)
      await waitForMessage() // authenticated

      ws.send(JSON.stringify({ type: 'message', content: 'hello' }))
      const firstChunk = await waitForMessage()
      expect(firstChunk.type).toBe('text')
      expect(firstChunk.text).toBe('Working...')

      ws.send(JSON.stringify({ type: 'command', content: '/stop' }))
      const stopMessage = await waitForMessage()
      expect(stopMessage.type).toBe('system')
      expect(stopMessage.text).toBe('Task aborted. No queued messages.')
      expect(agentCore.abort).toHaveBeenCalledTimes(1)

      releaseTask()
      ws.close()
    } finally {
      await new Promise<void>((resolve) => setTimeout(resolve, 20))
      for (const client of wss.clients) {
        client.terminate()
      }
      wss.close()
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      )
    }
  })

  it('emits only one session_end for /new when the backend broadcasts the divider', async () => {
    const db = initDatabase(':memory:')
    const chatEventBus = new ChatEventBus()
    const mockSessionManager = {
      getOrCreateSession: vi.fn(() => ({ id: 'session-1-mock', userId: '1', source: 'web', startedAt: Date.now(), lastActivity: Date.now(), messageCount: 0, summaryWritten: false, restored: false })),
    }
    const agentCore = {
      sendMessage: vi.fn(),
      abort: vi.fn(),
      resetSession: vi.fn(async () => {
        chatEventBus.broadcast({
          type: 'session_end',
          userId: 1,
          source: 'web',
          text: 'Summary once.',
        })
        return 'Summary once.'
      }),
      getSessionManager: vi.fn(() => mockSessionManager),
    } as unknown as AgentCore

    const app = createApp({ db })
    const server = http.createServer(app)
    const { wss } = setupWebSocketChat(server, db, agentCore, undefined, chatEventBus)

    await new Promise<void>((resolve) => server.listen(0, resolve))
    const port = (server.address() as { port: number }).port
    const token = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })

    try {
      const { ws, waitForMessage, expectNoMessageWithin } = await connectWs(port, token)
      await waitForMessage() // authenticated

      ws.send(JSON.stringify({ type: 'command', content: '/new' }))
      const sessionEnd = await waitForMessage()
      expect(sessionEnd.type).toBe('session_end')
      expect(sessionEnd.text).toBe('Summary once.')
      await expectNoMessageWithin(30)
      ws.close()
    } finally {
      for (const client of wss.clients) {
        client.terminate()
      }
      wss.close()
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      )
    }
  })

  it('streams thinking chunks, persists them with metadata.kind=thinking, and broadcasts them', async () => {
    const db = initDatabase(':memory:')
    const chatEventBus = new ChatEventBus()
    const mockSessionManager = {
      getOrCreateSession: vi.fn(() => ({ id: 'session-thinking', userId: '1', source: 'web', startedAt: Date.now(), lastActivity: Date.now(), messageCount: 0, summaryWritten: false, restored: false })),
    }
    const agentCore = {
      sendMessage: vi.fn(async function* (): AsyncGenerator<ResponseChunk> {
        yield { type: 'thinking', thinking: 'Hmm,' }
        yield { type: 'thinking', thinking: ' let me think.' }
        yield { type: 'text', text: 'Answer.' }
        yield { type: 'done' }
      }),
      abort: vi.fn(),
      resetSession: vi.fn(),
      getSessionManager: vi.fn(() => mockSessionManager),
    } as unknown as AgentCore

    const app = createApp({ db })
    const server = http.createServer(app)
    const { wss } = setupWebSocketChat(server, db, agentCore, undefined, chatEventBus)

    await new Promise<void>((resolve) => server.listen(0, resolve))
    const port = (server.address() as { port: number }).port
    const token = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })

    // Spy on the event bus so we can verify thinking broadcasts.
    const busEvents: Array<{ type: string; thinking?: string; text?: string }> = []
    chatEventBus.subscribe((ev) => {
      busEvents.push({ type: ev.type, thinking: ev.thinking, text: ev.text })
    })

    try {
      const { ws, waitForMessage } = await connectWs(port, token)
      await waitForMessage() // authenticated

      ws.send(JSON.stringify({ type: 'message', content: 'hello' }))

      const firstThinking = await waitForMessage()
      expect(firstThinking.type).toBe('thinking')
      expect(firstThinking.thinking).toBe('Hmm,')

      const secondThinking = await waitForMessage()
      expect(secondThinking.type).toBe('thinking')
      expect(secondThinking.thinking).toBe(' let me think.')

      const text = await waitForMessage()
      expect(text.type).toBe('text')
      expect(text.text).toBe('Answer.')

      const done = await waitForMessage()
      expect(done.type).toBe('done')

      // Thinking block persisted as its own assistant row with metadata.kind === 'thinking'
      const rows = db.prepare(
        "SELECT role, content, metadata FROM chat_messages WHERE session_id = 'session-thinking' ORDER BY id"
      ).all() as Array<{ role: string; content: string; metadata: string | null }>
      const thinkingRows = rows.filter(r => {
        if (!r.metadata) return false
        try {
          return (JSON.parse(r.metadata) as { kind?: string }).kind === 'thinking'
        } catch { return false }
      })
      expect(thinkingRows.length).toBe(1)
      expect(thinkingRows[0]!.role).toBe('assistant')
      expect(thinkingRows[0]!.content).toBe('Hmm, let me think.')

      // Assistant text persisted as its own row without thinking metadata
      const assistantTextRows = rows.filter(r => r.role === 'assistant' && (!r.metadata || !(() => { try { return (JSON.parse(r.metadata!) as { kind?: string }).kind === 'thinking' } catch { return false } })()))
      expect(assistantTextRows.length).toBe(1)
      expect(assistantTextRows[0]!.content).toBe('Answer.')

      // Event bus broadcasts thinking chunks (in addition to user_message/text/done)
      const broadcastedThinking = busEvents.filter(e => e.type === 'thinking')
      expect(broadcastedThinking.length).toBe(2)
      expect(broadcastedThinking[0]!.thinking).toBe('Hmm,')
      expect(broadcastedThinking[1]!.thinking).toBe(' let me think.')

      ws.close()
    } finally {
      for (const client of wss.clients) {
        client.terminate()
      }
      wss.close()
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      )
    }
  })

  it('forwards uploads attached to a tool_call_end chunk as an `attachment` ws message and persists them on the assistant row', async () => {
    const db = initDatabase(':memory:')
    const chatEventBus = new ChatEventBus()
    const mockSessionManager = {
      getOrCreateSession: vi.fn(() => ({ id: 'session-file', userId: '1', source: 'web', startedAt: Date.now(), lastActivity: Date.now(), messageCount: 0, summaryWritten: false, restored: false })),
    }
    const uploadDescriptor = {
      kind: 'file' as const,
      originalName: 'report.md',
      storedName: 'abc-report.md',
      relativePath: '2026/04/20/abc-report.md',
      urlPath: '/api/uploads/2026/04/20/abc-report.md',
      mimeType: 'text/markdown',
      size: 42,
    }
    const agentCore = {
      sendMessage: vi.fn(async function* (): AsyncGenerator<ResponseChunk> {
        yield { type: 'tool_call_start', toolName: 'send_file_to_user', toolCallId: 'tc-1', toolArgs: { path: 'report.md' } }
        yield {
          type: 'tool_call_end',
          toolName: 'send_file_to_user',
          toolCallId: 'tc-1',
          toolResult: { details: { uploadedFile: uploadDescriptor } },
        }
        yield { type: 'text', text: 'Here you go.' }
        yield { type: 'done' }
      }),
      abort: vi.fn(),
      resetSession: vi.fn(),
      getSessionManager: vi.fn(() => mockSessionManager),
    } as unknown as AgentCore

    const app = createApp({ db })
    const server = http.createServer(app)
    const { wss } = setupWebSocketChat(server, db, agentCore, undefined, chatEventBus)

    await new Promise<void>((resolve) => server.listen(0, resolve))
    const port = (server.address() as { port: number }).port
    const token = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })

    const busEvents: Array<{ type: string; attachment?: unknown }> = []
    chatEventBus.subscribe((ev) => {
      busEvents.push({ type: ev.type, attachment: ev.attachment })
    })

    try {
      const { ws, waitForMessage } = await connectWs(port, token)
      await waitForMessage() // authenticated

      ws.send(JSON.stringify({ type: 'message', content: 'send me the report' }))

      // Drain chunks until we see both the attachment ws msg and the done.
      const seen: string[] = []
      let attachmentMsg: Record<string, unknown> | null = null
      for (let i = 0; i < 20; i++) {
        const msg = await waitForMessage()
        seen.push(msg.type as string)
        if (msg.type === 'attachment') attachmentMsg = msg
        if (msg.type === 'done') break
      }

      expect(seen).toContain('attachment')
      expect(seen).toContain('done')
      expect(attachmentMsg?.attachment).toMatchObject({
        relativePath: uploadDescriptor.relativePath,
        originalName: uploadDescriptor.originalName,
      })

      // Attachment is also broadcast on the event bus for other tabs
      const busAttachments = busEvents.filter(e => e.type === 'attachment')
      expect(busAttachments.length).toBe(1)

      // Assistant row persists the upload as metadata.files so history reload
      // shows the download card
      const assistantRow = db.prepare(
        "SELECT content, metadata FROM chat_messages WHERE session_id = 'session-file' AND role = 'assistant'"
      ).get() as { content: string; metadata: string } | undefined
      expect(assistantRow).toBeDefined()
      expect(assistantRow!.content).toBe('Here you go.')
      const meta = JSON.parse(assistantRow!.metadata) as { files: Array<{ relativePath: string }> }
      expect(meta.files).toHaveLength(1)
      expect(meta.files[0]!.relativePath).toBe(uploadDescriptor.relativePath)

      ws.close()
    } finally {
      for (const client of wss.clients) {
        client.terminate()
      }
      wss.close()
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      )
    }
  })

  it('treats /kill as an alias for /stop over web chat', async () => {
    const db = initDatabase(':memory:')
    const mockSessionManager2 = {
      getOrCreateSession: vi.fn(() => ({ id: 'session-1-mock', userId: '1', source: 'web', startedAt: Date.now(), lastActivity: Date.now(), messageCount: 0, summaryWritten: false, restored: false })),
    }
    const agentCore = {
      sendMessage: vi.fn(),
      abort: vi.fn(),
      resetSession: vi.fn(),
      getSessionManager: vi.fn(() => mockSessionManager2),
    } as unknown as AgentCore

    const app = createApp({ db })
    const server = http.createServer(app)
    const { wss } = setupWebSocketChat(server, db, agentCore)

    await new Promise<void>((resolve) => server.listen(0, resolve))
    const port = (server.address() as { port: number }).port
    const token = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })

    try {
      const { ws, waitForMessage } = await connectWs(port, token)
      await waitForMessage() // authenticated

      ws.send(JSON.stringify({ type: 'command', content: '/kill' }))
      const stopMessage = await waitForMessage()
      expect(stopMessage.type).toBe('system')
      expect(stopMessage.text).toBe('Nothing to stop.')
      expect(agentCore.abort).not.toHaveBeenCalled()
      ws.close()
    } finally {
      for (const client of wss.clients) {
        client.terminate()
      }
      wss.close()
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      )
    }
  })
})
