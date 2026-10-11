import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { WebSocket } from 'ws'
import { initDatabase } from '@axiom/core'
import type { AgentCore, PushSubscriptionRecord, ResponseChunk } from '@axiom/core'
import { createApp } from './app.js'
import { generateAccessToken } from './auth.js'
import { setupWebSocketChat } from './ws-chat.js'
import type { PushNotificationPayload, PushNotifier } from './push/push-notifier.js'

let dataDir: string
let previousDataDir: string | undefined

beforeAll(() => {
  previousDataDir = process.env.DATA_DIR
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-ws-chat-push-'))
  process.env.DATA_DIR = dataDir
})

afterAll(() => {
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
  fs.rmSync(dataDir, { recursive: true, force: true })
})

interface Harness {
  port: number
  token: string
  sent: PushNotificationPayload[]
  notifier: PushNotifier
  close: () => Promise<void>
}

const harnesses: Harness[] = []

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map(harness => harness.close()))
})

async function startChat(gate: Promise<void> = Promise.resolve()): Promise<Harness> {
  const db = initDatabase(':memory:')
  const session = { id: 'session-push', userId: '1', source: 'web', startedAt: Date.now(), lastActivity: Date.now(), messageCount: 0, summaryWritten: false, restored: false }
  const agentCore = {
    sendMessage: vi.fn(async function* (): AsyncGenerator<ResponseChunk> {
      await gate
      yield { type: 'text', text: 'Here you go.' }
      yield { type: 'done' }
    }),
    abort: vi.fn(),
    getSessionManager: vi.fn(() => ({ getOrCreateSession: vi.fn(() => session) })),
  } as unknown as AgentCore
  const sent: PushNotificationPayload[] = []
  const notifier: PushNotifier = {
    getPublicKey: () => 'public',
    sendToUser: vi.fn(async (_userId, build) => {
      sent.push(build({ locale: 'en' } as PushSubscriptionRecord))
      return []
    }),
  }

  const server = http.createServer(createApp({ db }))
  const { wss } = setupWebSocketChat(server, db, agentCore, undefined, undefined, undefined, undefined, notifier)
  await new Promise<void>((resolve) => server.listen(0, resolve))

  const harness: Harness = {
    port: (server.address() as { port: number }).port,
    token: generateAccessToken({ userId: 1, username: 'admin', role: 'admin' }),
    sent,
    notifier,
    close: async () => {
      for (const client of wss.clients) client.terminate()
      wss.close()
      await new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())))
    },
  }
  harnesses.push(harness)
  return harness
}

function connect(harness: Harness): Promise<{ ws: WebSocket; next: (type: string) => Promise<Record<string, unknown>> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${harness.port}/ws/chat?token=${harness.token}`)
    const received: Record<string, unknown>[] = []
    const waiters: Array<{ type: string; resolve: (msg: Record<string, unknown>) => void }> = []
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>
      const waiter = waiters.find(entry => entry.type === msg.type)
      if (waiter) {
        waiters.splice(waiters.indexOf(waiter), 1)
        waiter.resolve(msg)
      } else {
        received.push(msg)
      }
    })
    ws.on('error', reject)
    ws.on('open', () => resolve({
      ws,
      next: (type) => {
        const index = received.findIndex(msg => msg.type === type)
        if (index >= 0) return Promise.resolve(received.splice(index, 1)[0]!)
        return new Promise(res => waiters.push({ type, resolve: res }))
      },
    }))
  })
}

describe('web chat push notifications', () => {
  it('pushes the finished reply when the only chat tab reported itself hidden', async () => {
    const harness = await startChat()
    const { ws, next } = await connect(harness)
    await next('system')

    ws.send(JSON.stringify({ type: 'visibility', visible: false }))
    ws.send(JSON.stringify({ type: 'message', content: 'hello' }))
    await next('done')

    await vi.waitFor(() => expect(harness.sent).toEqual([expect.objectContaining({ kind: 'chat_reply', body: 'Reply ready' })]))
    ws.close()
  })

  it('does not push while a chat tab is visible', async () => {
    const harness = await startChat()
    const hidden = await connect(harness)
    const visible = await connect(harness)
    await hidden.next('system')
    await visible.next('system')

    hidden.ws.send(JSON.stringify({ type: 'visibility', visible: false }))
    visible.ws.send(JSON.stringify({ type: 'visibility', visible: true }))
    hidden.ws.send(JSON.stringify({ type: 'message', content: 'hello' }))
    await hidden.next('done')
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(harness.notifier.sendToUser).not.toHaveBeenCalled()
    hidden.ws.close()
    visible.ws.close()
  })

  it('pushes when the user closed the app before the reply finished', async () => {
    let finishReply!: () => void
    const harness = await startChat(new Promise(resolve => { finishReply = resolve }))
    const { ws, next } = await connect(harness)
    await next('system')

    ws.send(JSON.stringify({ type: 'message', content: 'hello' }))
    await new Promise(resolve => setTimeout(resolve, 50))
    await new Promise<void>(resolve => {
      ws.once('close', () => resolve())
      ws.close()
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    finishReply()

    await vi.waitFor(() => expect(harness.sent).toHaveLength(1))
  })
})
