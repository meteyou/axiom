import { describe, it, expect, vi } from 'vitest'
import http from 'node:http'
import { WebSocket } from 'ws'
import { initDatabase } from '@openagent/core'
import type { AgentCore, ResponseChunk } from '@openagent/core'
import { createApp } from './app.js'
import { generateAccessToken } from './auth.js'
import { setupWebSocketChat } from './ws-chat.js'

interface BufferedWs {
  ws: WebSocket
  waitForMessage: () => Promise<Record<string, unknown>>
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
