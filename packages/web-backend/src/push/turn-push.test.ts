import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { TurnRunner } from '@axiom/core'
import type { PushSubscriptionRecord, ResponseChunk, TurnAgentLike } from '@axiom/core'
import {
  PREVIEW_MAX_CHARS,
  buildTestNotificationPayload,
  buildTurnNotificationPayload,
  createWebTurnPush,
  shouldNotifyAboutTurn,
  watchTurnOutcome,
} from './turn-push.js'
import type { ChatClientPresence, TurnOutcome } from './turn-push.js'
import type { PushNotificationPayload, PushNotifier } from './push-notifier.js'

let dataDir: string
let previousDataDir: string | undefined

beforeAll(() => {
  previousDataDir = process.env.DATA_DIR
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-turn-push-'))
  process.env.DATA_DIR = dataDir
})

afterAll(() => {
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
  fs.rmSync(dataDir, { recursive: true, force: true })
})

function agentStreaming(chunks: ResponseChunk[], gate?: Promise<void>): TurnAgentLike {
  return {
    async* sendMessage() {
      if (gate) await gate
      for (const chunk of chunks) yield chunk
    },
    abort: vi.fn(),
  }
}

function runnerFor(agent: TurnAgentLike): TurnRunner {
  return new TurnRunner({ db: null, getAgent: () => agent, retryPolicy: { enabled: false } })
}

function waitForOutcome(runner: TurnRunner, user: number, turnId: string): Promise<TurnOutcome> {
  return new Promise(resolve => watchTurnOutcome(runner, user, turnId, resolve))
}

describe('shouldNotifyAboutTurn', () => {
  it('notifies when the user has no chat connection at all', () => {
    expect(shouldNotifyAboutTurn([])).toBe(true)
  })

  it('notifies when every connection is in the background', () => {
    expect(shouldNotifyAboutTurn([{ visible: false }, { visible: false }])).toBe(true)
  })

  it('stays quiet while any connection is visible', () => {
    expect(shouldNotifyAboutTurn([{ visible: false }, { visible: true }])).toBe(false)
  })
})

describe('buildTurnNotificationPayload', () => {
  const reply: TurnOutcome = { status: 'completed', replyText: 'Here is the **summary** you asked for.' }

  it('contains no message content by default', () => {
    expect(buildTurnNotificationPayload(reply, { showPreview: false })).toEqual({
      kind: 'chat_reply',
      title: 'Axiom',
      body: 'Reply ready',
      url: '/',
      tag: 'axiom-chat',
    })
  })

  it('adds the start of the reply when the preview is enabled', () => {
    expect(buildTurnNotificationPayload(reply, { showPreview: true }).body).toBe('Here is the **summary** you asked for.')
  })

  it('cuts long previews to the limit and collapses whitespace', () => {
    const long = `Line one\n\n${'word '.repeat(60)}`
    const body = buildTurnNotificationPayload({ status: 'completed', replyText: long }, { showPreview: true }).body

    expect(body.length).toBeLessThanOrEqual(PREVIEW_MAX_CHARS)
    expect(body.length).toBeGreaterThan(PREVIEW_MAX_CHARS - 5)
    expect(body.startsWith('Line one word word')).toBe(true)
    expect(body.endsWith('…')).toBe(true)
    expect(body).not.toContain('\n')
  })

  it('falls back to the generic text when the reply has no text', () => {
    expect(buildTurnNotificationPayload({ status: 'completed', replyText: '  ' }, { showPreview: true }).body).toBe('Reply ready')
  })

  it('reports failures without the error unless the preview is enabled', () => {
    const failed: TurnOutcome = { status: 'failed', error: '401 invalid api key' }

    expect(buildTurnNotificationPayload(failed, { showPreview: false })).toMatchObject({ kind: 'chat_error', body: 'The reply failed' })
    expect(buildTurnNotificationPayload(failed, { showPreview: true }).body).toBe('401 invalid api key')
  })

  it('uses the device locale', () => {
    expect(buildTurnNotificationPayload(reply, { showPreview: false, locale: 'de' }).body).toBe('Antwort fertig')
    expect(buildTurnNotificationPayload(reply, { showPreview: false, locale: 'fr' }).body).toBe('Reply ready')
    expect(buildTestNotificationPayload('de-AT').body).toContain('Testbenachrichtigung')
  })
})

describe('watchTurnOutcome', () => {
  it('reports the answer after the last tool call', async () => {
    const runner = runnerFor(agentStreaming([
      { type: 'text', text: 'Let me check.' },
      { type: 'tool_call_start', toolName: 'shell', toolCallId: 't1', toolArgs: {} },
      { type: 'tool_call_end', toolName: 'shell', toolCallId: 't1', toolResult: 'ok' },
      { type: 'text', text: 'All ' },
      { type: 'text', text: 'done.' },
      { type: 'done' },
    ]))
    const turn = runner.startTurn({ userId: 1, sessionId: 's1', text: 'hi' })

    await expect(waitForOutcome(runner, 1, turn.turnId)).resolves.toEqual({ status: 'completed', replyText: 'All done.' })
  })

  it('keeps the earlier text when the turn ends on a tool call', async () => {
    const runner = runnerFor(agentStreaming([
      { type: 'text', text: 'Saved the file.' },
      { type: 'tool_call_start', toolName: 'write_file', toolCallId: 't1', toolArgs: {} },
      { type: 'tool_call_end', toolName: 'write_file', toolCallId: 't1', toolResult: 'ok' },
      { type: 'done' },
    ]))
    const turn = runner.startTurn({ userId: 1, sessionId: 's1', text: 'hi' })

    await expect(waitForOutcome(runner, 1, turn.turnId)).resolves.toEqual({ status: 'completed', replyText: 'Saved the file.' })
  })

  it('reports a terminal failure', async () => {
    const runner = runnerFor(agentStreaming([{ type: 'error', error: 'Invalid API key' }]))
    const turn = runner.startTurn({ userId: 1, sessionId: 's1', text: 'hi' })

    await expect(waitForOutcome(runner, 1, turn.turnId)).resolves.toEqual({ status: 'failed', error: 'Invalid API key' })
  })

  it('ignores the events of other turns of the same user', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const runner = runnerFor(agentStreaming([{ type: 'text', text: 'answer' }, { type: 'done' }], gate))
    const first = runner.startTurn({ userId: 1, sessionId: 's1', text: 'one' })
    const second = runner.startTurn({ userId: 1, sessionId: 's1', text: 'two' })
    const settled: string[] = []
    watchTurnOutcome(runner, 1, second.turnId, () => settled.push('second'))
    const firstDone = waitForOutcome(runner, 1, first.turnId).then(() => settled.push('first'))

    release()
    await firstDone
    expect(settled).toEqual(['first'])
  })
})

describe('createWebTurnPush', () => {
  function setup(clients: ChatClientPresence[], options: { showPreview?: boolean } = {}) {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const runner = runnerFor(agentStreaming([{ type: 'text', text: 'The answer is 42.' }, { type: 'done' }], gate))
    const sent: PushNotificationPayload[] = []
    const notifier: PushNotifier = {
      getPublicKey: () => 'public',
      sendToUser: vi.fn(async (_userId, build) => {
        sent.push(build({ locale: 'en' } as PushSubscriptionRecord))
        return []
      }),
    }
    const push = createWebTurnPush({
      runner,
      notifier,
      getClients: () => clients,
      getShowPreview: () => options.showPreview ?? false,
    })
    return { runner, notifier, push, sent, release }
  }

  async function finishTurn(runner: TurnRunner, turnId: string, release: () => void) {
    const done = waitForOutcome(runner, 3, turnId)
    release()
    await done
  }

  it('pushes when the user left the chat while the turn was running', async () => {
    const clients: ChatClientPresence[] = [{ visible: true }]
    const { runner, push, sent, release } = setup(clients)
    const turn = runner.startTurn({ userId: 3, sessionId: 's', text: 'hi' })
    push.watch(3, turn.turnId)

    clients[0]!.visible = false
    await finishTurn(runner, turn.turnId, release)

    expect(sent).toEqual([expect.objectContaining({ kind: 'chat_reply', body: 'Reply ready' })])
  })

  it('stays quiet while the chat is visible', async () => {
    const { runner, notifier, push, release } = setup([{ visible: true }])
    const turn = runner.startTurn({ userId: 3, sessionId: 's', text: 'hi' })
    push.watch(3, turn.turnId)

    await finishTurn(runner, turn.turnId, release)

    expect(notifier.sendToUser).not.toHaveBeenCalled()
  })

  it('includes the preview when the user enabled it', async () => {
    const { runner, push, sent, release } = setup([], { showPreview: true })
    const turn = runner.startTurn({ userId: 3, sessionId: 's', text: 'hi' })
    push.watch(3, turn.turnId)

    await finishTurn(runner, turn.turnId, release)

    expect(sent[0]?.body).toBe('The answer is 42.')
  })

  it('drops the notification of a turn the user cancelled', async () => {
    const { runner, notifier, push, release } = setup([])
    const turn = runner.startTurn({ userId: 3, sessionId: 's', text: 'hi' })
    push.watch(3, turn.turnId)

    push.cancelForUser(3)
    await finishTurn(runner, turn.turnId, release)

    expect(notifier.sendToUser).not.toHaveBeenCalled()
  })
})
