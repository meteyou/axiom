import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import type { AssistantMessageEvent, AssistantMessageEventStream } from '@earendil-works/pi-ai'
import type { StreamFn } from '@earendil-works/pi-agent-core'

type TextDelta = Extract<AssistantMessageEvent, { type: 'text_delta' }>

/**
 * pi-ai's openai-completions adapter emits a chunk's `content` before its
 * `reasoning_content`. When one chunk straddles the end of the reasoning
 * (multi-token chunks, e.g. vLLM with speculative decoding), the reasoning
 * tail arrives after the first text and the UI splits the thinking block
 * around it. Holding each text delta until the next event lets such a late
 * delta for an earlier thinking block go first.
 */
export function withOrderedThinking(streamFn: StreamFn): StreamFn {
  return async (model, context, options) => reorderLateThinking(await streamFn(model, context, options))
}

export function reorderLateThinking(source: AssistantMessageEventStream): AssistantMessageEventStream {
  const ordered = createAssistantMessageEventStream()
  void (async () => {
    let held: TextDelta | null = null
    for await (const event of source) {
      if (held && !isLateThinking(event, held)) {
        ordered.push(held)
        held = null
      }
      if (event.type === 'text_delta' && followsThinking(event)) held = event
      else ordered.push(event)
    }
    if (held) ordered.push(held)
    ordered.end(await source.result())
  })()
  return ordered
}

function isLateThinking(event: AssistantMessageEvent, held: TextDelta): boolean {
  return event.type === 'thinking_delta' && event.contentIndex < held.contentIndex
}

function followsThinking(event: TextDelta): boolean {
  return event.partial.content.slice(0, event.contentIndex).some(block => block.type === 'thinking')
}
