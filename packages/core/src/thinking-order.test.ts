import { describe, expect, it } from 'vitest'
import { createAssistantMessageEventStream, fauxAssistantMessage } from '@earendil-works/pi-ai'
import type { AssistantMessage, AssistantMessageEvent } from '@earendil-works/pi-ai'
import { reorderLateThinking } from './thinking-order.js'

type Step = ['thinking' | 'text', number, string]

async function run(content: AssistantMessage['content'], steps: Step[]): Promise<string[]> {
  const partial: AssistantMessage = { ...fauxAssistantMessage(''), content }
  const source = createAssistantMessageEventStream()
  for (const [kind, contentIndex, delta] of steps) {
    source.push({ type: `${kind}_delta`, contentIndex, delta, partial } as AssistantMessageEvent)
  }
  source.push({ type: 'done', reason: 'stop', message: partial })

  const seen: string[] = []
  const ordered = reorderLateThinking(source)
  for await (const event of ordered) {
    if (event.type === 'thinking_delta' || event.type === 'text_delta') seen.push(`${event.type.split('_')[0]}:${event.delta}`)
    else seen.push(event.type)
  }
  expect(await ordered.result()).toBe(partial)
  return seen
}

const thinkingThenText: AssistantMessage['content'] = [
  { type: 'thinking', thinking: '' },
  { type: 'text', text: '' },
]

describe('reorderLateThinking', () => {
  it('moves a reasoning tail that shared a chunk with the first text in front of it', async () => {
    const seen = await run(thinkingThenText, [
      ['thinking', 0, 'answer in'],
      ['text', 1, '\n\npong'],
      ['thinking', 0, ' German.\n'],
      ['text', 1, '!'],
    ])
    expect(seen).toEqual(['thinking:answer in', 'thinking: German.\n', 'text:\n\npong', 'text:!', 'done'])
  })

  it('keeps text order and flushes the last held delta before the stream ends', async () => {
    const seen = await run(thinkingThenText, [
      ['thinking', 0, 'hmm'],
      ['text', 1, 'a'],
      ['text', 1, 'b'],
    ])
    expect(seen).toEqual(['thinking:hmm', 'text:a', 'text:b', 'done'])
  })

  it('does not pull a thinking block that starts after the text in front of it', async () => {
    const seen = await run([...thinkingThenText, { type: 'thinking', thinking: '' }], [
      ['thinking', 0, 'first'],
      ['text', 1, 'answer'],
      ['thinking', 2, 'second'],
    ])
    expect(seen).toEqual(['thinking:first', 'text:answer', 'thinking:second', 'done'])
  })

  it('leaves text without preceding thinking untouched', async () => {
    const seen = await run([{ type: 'text', text: '' }, { type: 'thinking', thinking: '' }], [
      ['text', 0, 'answer'],
      ['thinking', 1, 'late'],
    ])
    expect(seen).toEqual(['text:answer', 'thinking:late', 'done'])
  })
})
