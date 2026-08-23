import { describe, expect, it } from 'vitest'
import { stripTrailingTurn } from './useChat'
import type { ChatMessage } from './useChat'

function msg(role: ChatMessage['role'], content: string): ChatMessage {
  return { role, content }
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

  it('keeps system messages that were interleaved into the running turn', () => {
    const list = [
      msg('user', 'question'),
      msg('system', '⏳ Provider has not responded for 30s…'),
      msg('assistant', 'partial'),
    ]

    expect(stripTrailingTurn(list).map(m => m.role)).toEqual(['user', 'system'])
  })

  it('returns the same array when there is nothing to strip', () => {
    const list = [msg('user', 'question')]
    expect(stripTrailingTurn(list)).toBe(list)
    expect(stripTrailingTurn([])).toEqual([])
  })
})
