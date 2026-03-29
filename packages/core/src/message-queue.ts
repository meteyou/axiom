import { EventEmitter } from 'node:events'

export interface QueuedMessage {
  id: string
  type: 'user_message' | 'task_injection'
  payload: {
    userId: string
    text: string
    source: string
  }
}

/**
 * In-memory message queue that serializes all inputs to the main agent.
 * Both user chat messages and task result injections go through this queue
 * to prevent concurrent processing collisions.
 *
 * Uses a simple mutex pattern: acquires a lock before processing,
 * releases it when the consumer finishes iterating the response.
 */
export class MessageQueue extends EventEmitter {
  private pendingCount = 0
  private lockPromise: Promise<void> = Promise.resolve()
  private releaseLock: (() => void) | null = null

  /**
   * Acquire the processing lock. Waits until any current processing is done.
   * Returns a release function that MUST be called when processing is complete.
   */
  async acquire(): Promise<{ release: () => void; message: QueuedMessage }> {
    // This should not be called directly — use enqueue instead
    throw new Error('Use enqueue() instead')
  }

  /**
   * Enqueue a message for sequential processing.
   * Returns a wrapped async iterable from the processor.
   * The next queued message won't start until this iterable is fully consumed.
   */
  async enqueue<T>(
    type: 'user_message' | 'task_injection',
    userId: string,
    text: string,
    source: string,
    processor: (msg: QueuedMessage) => AsyncIterable<T>,
  ): Promise<AsyncIterable<T>> {
    const msg: QueuedMessage = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      type,
      payload: { userId, text, source },
    }

    this.pendingCount++
    this.emit('enqueued', msg)

    // Wait for our turn
    const previousLock = this.lockPromise
    let releaseFn: () => void
    this.lockPromise = new Promise<void>((resolve) => {
      releaseFn = resolve
    })

    await previousLock
    this.pendingCount--

    // We now have the lock — run the processor
    const iterable = processor(msg)

    // Wrap iterable to release lock when fully consumed
    const lockRelease = releaseFn!
    const wrapped = async function* (): AsyncIterable<T> {
      try {
        for await (const chunk of iterable) {
          yield chunk
        }
      } finally {
        lockRelease()
      }
    }

    return wrapped()
  }

  /**
   * Get the number of pending (waiting) messages
   */
  get length(): number {
    return this.pendingCount
  }

  /**
   * Check if any message is currently being processed
   */
  get isProcessing(): boolean {
    return this.pendingCount > 0 || this.releaseLock !== null
  }
}
