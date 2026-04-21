import { describe, it, expect } from 'vitest'
import { MessageQueue } from './message-queue.js'
import type { QueuedMessage } from './message-queue.js'

describe('MessageQueue', () => {
  describe('sequential processing', () => {
    it('processes messages one at a time', async () => {
      const queue = new MessageQueue()
      const processingOrder: string[] = []

      const processor = (msg: QueuedMessage) => {
        return (async function* () {
          processingOrder.push(`start:${msg.payload.text}`)
          await new Promise(resolve => setTimeout(resolve, 20))
          yield { type: 'text', text: msg.payload.text }
          processingOrder.push(`end:${msg.payload.text}`)
        })()
      }

      // Enqueue two messages — they should serialize
      const p1 = queue.enqueue('user_message', 'user1', 'msg1', 'web', processor)
      const p2 = queue.enqueue('user_message', 'user1', 'msg2', 'web', processor)

      // msg1 starts immediately, msg2 waits
      const iter1 = await p1
      for await (const _ of iter1) { /* consume */ }

      // Now msg2 can proceed
      const iter2 = await p2
      for await (const _ of iter2) { /* consume */ }

      // Verify sequential: msg1 completes before msg2 starts
      expect(processingOrder).toEqual([
        'start:msg1', 'end:msg1',
        'start:msg2', 'end:msg2',
      ])
    })

    it('handles three messages sequentially', async () => {
      const queue = new MessageQueue()
      const order: number[] = []

      const processor = (msg: QueuedMessage) => {
        const num = parseInt(msg.payload.text)
        return (async function* () {
          order.push(num)
          yield num
        })()
      }

      const p1 = queue.enqueue('user_message', 'u', '1', 'web', processor)
      const p2 = queue.enqueue('user_message', 'u', '2', 'web', processor)
      const p3 = queue.enqueue('user_message', 'u', '3', 'web', processor)

      for await (const _ of await p1) { /* consume */ }
      for await (const _ of await p2) { /* consume */ }
      for await (const _ of await p3) { /* consume */ }

      expect(order).toEqual([1, 2, 3])
    })
  })

  describe('task injection ordering', () => {
    it('processes task injections in queue order with user messages', async () => {
      const queue = new MessageQueue()
      const processed: string[] = []

      const processor = (msg: QueuedMessage) => {
        return (async function* () {
          processed.push(`${msg.type}:${msg.payload.text}`)
          yield { type: 'text', text: msg.payload.text }
        })()
      }

      const p1 = queue.enqueue('user_message', 'user1', 'hello', 'web', processor)
      const p2 = queue.enqueue('task_injection', 'system', 'result', 'task', processor)

      for await (const _ of await p1) { /* consume */ }
      for await (const _ of await p2) { /* consume */ }

      expect(processed).toEqual([
        'user_message:hello',
        'task_injection:result',
      ])
    })

    it('interleaves user messages and task injections correctly', async () => {
      const queue = new MessageQueue()
      const processed: string[] = []

      const processor = (msg: QueuedMessage) => {
        return (async function* () {
          processed.push(msg.payload.text)
          yield msg.payload.text
        })()
      }

      const p1 = queue.enqueue('user_message', 'u', 'user1', 'web', processor)
      const p2 = queue.enqueue('task_injection', 's', 'task1', 'task', processor)
      const p3 = queue.enqueue('user_message', 'u', 'user2', 'web', processor)

      for await (const _ of await p1) { /* consume */ }
      for await (const _ of await p2) { /* consume */ }
      for await (const _ of await p3) { /* consume */ }

      expect(processed).toEqual(['user1', 'task1', 'user2'])
    })
  })

  describe('queue management', () => {
    it('reports pending count correctly', async () => {
      const queue = new MessageQueue()
      const processed: string[] = []

      // A processor that yields immediately
      const processor = (msg: QueuedMessage) => {
        return (async function* () {
          processed.push(msg.payload.text)
          yield msg.payload.text
        })()
      }

      // First enqueue resolves immediately (no contention)
      // Second enqueue waits for first to complete
      const p1 = queue.enqueue('user_message', 'u', 'msg1', 'web', processor)

      // Before consuming, enqueue a second (it increments pending)
      const p2 = queue.enqueue('user_message', 'u', 'msg2', 'web', processor)

      // Both enqueued but p1 acquired lock synchronously so pendingCount
      // may be 1 or 2 depending on microtask timing. p2 is definitely waiting.
      expect(queue.length).toBeGreaterThanOrEqual(1)

      // Consume first
      const iter1 = await p1
      for await (const _ of iter1) { /* consume */ }

      // Consume second
      const iter2 = await p2
      for await (const _ of iter2) { /* consume */ }

      expect(processed).toEqual(['msg1', 'msg2'])
      expect(queue.length).toBe(0)
    })
  })

  describe('event emission', () => {
    it('emits enqueued event', async () => {
      const queue = new MessageQueue()
      const enqueued: QueuedMessage[] = []
      queue.on('enqueued', (msg: QueuedMessage) => enqueued.push(msg))

      const processor = () => (async function* () { yield 'ok' })()

      const iter = await queue.enqueue('user_message', 'user1', 'hello', 'web', processor)
      for await (const _ of iter) { /* consume */ }

      expect(enqueued).toHaveLength(1)
      expect(enqueued[0].payload.text).toBe('hello')
      expect(enqueued[0].type).toBe('user_message')
    })
  })

  describe('error handling', () => {
    it('releases lock even if processor throws', async () => {
      const queue = new MessageQueue()

      const failingProcessor = () => {
        // eslint-disable-next-line require-yield -- intentionally throws before yielding to test error path
        return (async function* () {
          throw new Error('processor error')
        })()
      }

      const successProcessor = () => {
        return (async function* () {
          yield 'success'
        })()
      }

      // First message will fail
      const p1 = queue.enqueue('user_message', 'u', 'fail', 'web', failingProcessor)
      const iter1 = await p1
      try {
        for await (const _ of iter1) { /* consume */ }
      } catch {
        // expected
      }

      // Second message should still work (lock released)
      const p2 = queue.enqueue('user_message', 'u', 'ok', 'web', successProcessor)
      const iter2 = await p2
      const chunks: string[] = []
      for await (const chunk of iter2) {
        chunks.push(chunk as string)
      }
      expect(chunks).toEqual(['success'])
    })
  })
})
