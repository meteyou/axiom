import { describe, expect, it } from 'vitest'
import { stripFailedAttempt, stripTrailingTurn, upsertStallMessage } from './useChat'
import type { ChatMessage, ChatStallInfo } from './useChat'

function msg(role: ChatMessage['role'], content: string): ChatMessage {
  return { role, content }
}

function stall(overrides: Partial<ChatStallInfo> = {}): ChatStallInfo {
  return {
    messageId: 42,
    startedAt: '2026-01-01T00:00:00.000Z',
    durationMs: 30_000,
    ...overrides,
  }
}

describe('stripTrailingTurn', () => {
  it('removes the partial turn rendered after the last user message', () => {
    const list = [
      msg('user', 'first question'),
      msg('assistant', 'first answer'),
      msg('user', 'second question'),
      msg('assistant', 'thinking…'),
      msg('tool', 'Tool: search'),
      msg('assistant', 'partial answer'),
    ]

    expect(stripTrailingTurn(list).map(m => m.content)).toEqual([
      'first question',
      'first answer',
      'second question',
    ])
  })

  it('keeps plain system messages that were interleaved into the running turn', () => {
    const list = [
      msg('user', 'question'),
      msg('system', 'Task aborted. No queued messages.'),
      msg('assistant', 'partial'),
    ]

    expect(stripTrailingTurn(list).map(m => m.role)).toEqual(['user', 'system'])
  })

  it('strips a stall notice together with the turn it belongs to', () => {
    const list: ChatMessage[] = [
      msg('user', 'question'),
      msg('assistant', 'thinking…'),
      { role: 'system', content: '⏳ Provider has not responded for 30s…', stallInfo: stall() },
      msg('assistant', 'partial'),
    ]

    expect(stripTrailingTurn(list).map(m => m.role)).toEqual(['user'])
  })
})

describe('stripFailedAttempt', () => {
  it('removes the partial answer of the discarded attempt', () => {
    const list = [
      msg('user', 'question'),
      msg('assistant', 'thinking…'),
      msg('tool', 'Tool: search'),
      msg('assistant', 'half an answer'),
    ]

    expect(stripFailedAttempt(list).map(m => m.content)).toEqual(['question'])
  })

  it('keeps stall notices, which stay part of the persisted history', () => {
    const list: ChatMessage[] = [
      msg('user', 'question'),
      { role: 'system', content: '⚠️ Provider stopped responding', stallInfo: stall({ outcome: 'aborted' }) },
      msg('assistant', 'half an answer'),
    ]

    expect(stripFailedAttempt(list).map(m => m.role)).toEqual(['user', 'system'])
  })

  it('stops at the user message of an earlier, completed turn', () => {
    const list = [
      msg('user', 'first question'),
      msg('assistant', 'first answer'),
      msg('user', 'second question'),
      msg('assistant', 'half an answer'),
    ]

    expect(stripFailedAttempt(list).map(m => m.content)).toEqual([
      'first question',
      'first answer',
      'second question',
    ])
  })
})

describe('upsertStallMessage', () => {
  it('appends the warning before trailing streaming messages', () => {
    const list: ChatMessage[] = [
      msg('user', 'question'),
      { role: 'assistant', content: 'partial', streaming: true },
    ]

    const updated = upsertStallMessage(list, stall(), '⏳ Provider has not responded for 30s…')
    expect(updated.map(m => m.role)).toEqual(['user', 'system', 'assistant'])
    expect(updated[1]!.content).toContain('has not responded for 30s')
    expect(updated[1]!.stallInfo?.outcome).toBeUndefined()
  })

  it('updates the existing notice in place when the stall resolves', () => {
    const warned = upsertStallMessage([msg('user', 'question')], stall(), '⏳ Provider has not responded for 30s…')
    const resolved = upsertStallMessage(warned, stall({
      resolvedAt: '2026-01-01T00:00:45.000Z',
      durationMs: 45_000,
      outcome: 'recovered',
    }), '✅ Provider recovered after 45s of silence')

    expect(resolved).toHaveLength(2)
    expect(resolved[1]!.stallInfo?.outcome).toBe('recovered')
    expect(resolved[1]!.content).toContain('recovered after 45s')
  })

  it('matches a notice restored from history by its persisted row id', () => {
    const fromHistory: ChatMessage[] = [
      msg('user', 'question'),
      {
        id: 42,
        role: 'system',
        content: '⏳ Provider has not responded for 30s…',
        stallInfo: stall(),
      },
    ]

    const resolved = upsertStallMessage(
      fromHistory,
      stall({ durationMs: 60_000, outcome: 'aborted' }),
      '⚠️ Provider stopped responding — aborted after 60s of silence',
    )
    expect(resolved).toHaveLength(2)
    expect(resolved[1]!.content).toContain('stopped responding')
  })

  it('appends a notice that has no persisted row id', () => {
    const updated = upsertStallMessage([msg('user', 'question')], stall({ messageId: undefined }), 'stalled')
    expect(updated).toHaveLength(2)
    const twice = upsertStallMessage(updated, stall({ messageId: undefined }), 'stalled')
    expect(twice).toHaveLength(3)
  })
})
