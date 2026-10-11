import { describe, expect, it } from 'vitest'
import type { AgentMessage, StreamFn } from '@earendil-works/pi-agent-core'
import type { Api, AssistantMessage, JsonObject, Model, ToolCall, Usage } from '@earendil-works/pi-ai'
import {
  CompactionAbortedError,
  EXTERNAL_ACTIONS_HEADING,
  IMAGE_TOKEN_ESTIMATE,
  SUMMARIZATION_SYSTEM_PROMPT,
  checkCompactionInvariant,
  collectExternalActions,
  compactMessages,
  estimateContextTokens,
  findCutPoint,
  findSummaryMessage,
  getCompactionWarningScopes,
  insertExternalActions,
  mergeExternalActions,
  parseExternalActions,
  resolveCompactionSettings,
  resolveEffectiveCompactionBudget,
  serializeConversation,
  shouldCompact,
} from './compaction.js'

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

const model = {
  id: 'test-model',
  name: 'Test',
  api: 'openai-completions',
  provider: 'test',
  baseUrl: 'http://localhost',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 8_000,
} as unknown as Model<Api>

let clock = 1_000

function system(text = 'You are a helpful agent.'): AgentMessage {
  return { role: 'system', content: text, timestamp: 0 }
}

/** The system message pi-agent-core inserts to declare tools. */
function toolDeclaration(name = 'shell'): AgentMessage {
  return {
    role: 'system',
    content: '',
    toolsAdded: [{ name, description: `${name} tool`, parameters: { type: 'object', properties: {} } }],
    timestamp: ++clock,
  } as AgentMessage
}

function user(text: string): AgentMessage {
  return { role: 'user', content: [{ type: 'text', text }], timestamp: ++clock }
}

function assistant(text: string, options: { toolCalls?: ToolCall[]; usage?: Partial<Usage> } = {}): AssistantMessage {
  return {
    role: 'assistant',
    content: [...(text ? [{ type: 'text' as const, text }] : []), ...(options.toolCalls ?? [])],
    api: 'openai-completions',
    provider: 'test',
    model: 'test-model',
    usage: { ...ZERO_USAGE, ...options.usage },
    stopReason: options.toolCalls?.length ? 'toolUse' : 'stop',
    timestamp: ++clock,
  }
}

function toolCall(id: string, name: string, args: JsonObject): ToolCall {
  return { type: 'toolCall', id, name, arguments: args }
}

function toolResult(id: string, name: string, text: string, isError = false): AgentMessage {
  return { role: 'toolResult', toolCallId: id, toolName: name, content: [{ type: 'text', text }], isError, timestamp: ++clock }
}

/** ~`tokens` tokens of text under the chars/4 heuristic. */
function filler(tokens: number): string {
  return 'x'.repeat(tokens * 4)
}

interface RecordedCall {
  prompt: string
  systemPrompt: string
  maxTokens?: number
}

function fakeStreamFn(reply: (prompt: string, call: number) => string, calls: RecordedCall[] = []): StreamFn {
  return (async (_model, context, options) => {
    const messages = context.messages as unknown as Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>
    const textOf = (content: string | Array<{ type: string; text?: string }>) =>
      typeof content === 'string' ? content : content.map(block => block.text ?? '').join('')
    const prompt = textOf(messages.find(m => m.role === 'user')!.content)
    const systemPrompt = textOf(messages.find(m => m.role === 'system')?.content ?? '')
    calls.push({ prompt, systemPrompt, maxTokens: options?.maxTokens })
    const text = reply(prompt, calls.length)
    const message: AssistantMessage = {
      ...assistant(text, { usage: { input: 1000, output: 200, totalTokens: 1200 } }),
      stopReason: options?.signal?.aborted ? 'aborted' : 'stop',
    }
    return streamOf(message)
  }) as StreamFn
}

/** A finished event stream: iterates nothing, resolves `message`. */
function streamOf(message: AssistantMessage): ReturnType<StreamFn> {
  return { async *[Symbol.asyncIterator]() {}, result: async () => message } as unknown as ReturnType<StreamFn>
}

const SUMMARY = `## Goal
- Ship the feature

## Constraints & Preferences
- (none)

## Progress
### Done
- [x] Opened the PR

### In Progress
- [ ] Waiting for CI

### Blocked
- (none)

## Key Decisions
- **Port instead of depend**: lighter

## Open Threads & Next Steps
1. Check CI

## Critical Context
- PR #42`

describe('resolveCompactionSettings', () => {
  it('uses the defaults unless settings.json tunes the token budgets', () => {
    expect(resolveCompactionSettings('interactive', undefined)).toEqual({ enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 })
    expect(resolveCompactionSettings('task', { reserveTokens: 10_000, keepRecentTokens: 12_000 }))
      .toEqual({ enabled: true, reserveTokens: 10_000, keepRecentTokens: 12_000 })
  })

  it('rejects invalid token values from settings.json', () => {
    expect(() => resolveCompactionSettings('interactive', { reserveTokens: 0 })).toThrow('compaction.reserveTokens must be a positive integer')
    expect(() => resolveCompactionSettings('interactive', { keepRecentTokens: '5000' as unknown as number }))
      .toThrow('compaction.keepRecentTokens must be a positive integer')
  })

  it('uses the global switch as a master switch for tasks', () => {
    expect(resolveCompactionSettings('task', { enabled: false, tasks: { enabled: true } }).enabled).toBe(false)
    expect(resolveCompactionSettings('task', { enabled: true, tasks: { enabled: false } }).enabled).toBe(false)
    expect(resolveCompactionSettings('interactive', { enabled: true, tasks: { enabled: false } }).enabled).toBe(true)
  })
})

describe('resolveEffectiveCompactionBudget', () => {
  it('caps budgets on a 40k window so a compaction leaves room for several turns', () => {
    const budget = resolveEffectiveCompactionBudget(resolveCompactionSettings('task', undefined), 40_000)
    expect(budget).toMatchObject({ reserveTokens: 10_000, triggerTokens: 30_000, keepRecentTokens: 9_000, summaryTargetTokens: 4_500, summaryMaxTokens: 8_000 })
    const invariant = checkCompactionInvariant(budget, 4_000)
    expect(invariant).toEqual({ ok: true, requiredTokens: 17_500, budgetTokens: 18_000 })
  })

  it('flags an 8k window as too small for a 4k system prompt', () => {
    const budget = resolveEffectiveCompactionBudget(resolveCompactionSettings('task', undefined), 8_000)
    expect(budget).toMatchObject({ reserveTokens: 2_000, triggerTokens: 6_000, keepRecentTokens: 1_800, summaryTargetTokens: 900, summaryMaxTokens: 1_600 })
    expect(checkCompactionInvariant(budget, 4_000).ok).toBe(false)
    expect(getCompactionWarningScopes(8_000, undefined)).toEqual(['interactive', 'task'])
  })

  it('triggers near the window limit on a 1M window', () => {
    const budget = resolveEffectiveCompactionBudget(resolveCompactionSettings('interactive', undefined), 1_000_000)
    expect(budget).toMatchObject({ reserveTokens: 16_384, triggerTokens: 983_616, keepRecentTokens: 20_000, summaryTargetTokens: 8_192, summaryMaxTokens: 13_107 })
    expect(getCompactionWarningScopes(1_000_000, undefined)).toEqual([])
  })

  it('compacts only above the trigger', () => {
    const budget = resolveEffectiveCompactionBudget(resolveCompactionSettings('interactive', undefined), 1_000_000)
    expect(shouldCompact(983_616, budget)).toBe(false)
    expect(shouldCompact(983_617, budget)).toBe(true)
    expect(shouldCompact(990_000, budget, false)).toBe(false)
  })
})

describe('estimateContextTokens', () => {
  it('uses the last assistant usage plus a heuristic for what follows', () => {
    const messages = [
      system(),
      user('hi'),
      assistant('hello', { usage: { input: 5_000, output: 100, totalTokens: 5_100 } }),
      user(filler(250)),
    ]
    expect(estimateContextTokens(messages)).toMatchObject({ usageTokens: 5_100, trailingTokens: 250, tokens: 5_350, lastUsageIndex: 2 })
  })

  it('counts an image as a flat estimate', () => {
    const messages: AgentMessage[] = [{ role: 'user', content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }], timestamp: 1 }]
    expect(estimateContextTokens(messages).tokens).toBe(IMAGE_TOKEN_ESTIMATE)
  })

  it('ignores the usage of messages a compaction kept, but trusts answers after it', async () => {
    const budget = resolveEffectiveCompactionBudget(resolveCompactionSettings('interactive', { keepRecentTokens: 100 }), 100_000)
    const stale = assistant('old answer', { usage: { input: 90_000, totalTokens: 90_000 } })
    const outcome = await compactMessages(
      [system(), user(filler(2_000)), assistant(filler(2_000)), user(filler(200)), stale],
      { budget, model, streamFn: fakeStreamFn(() => SUMMARY), now: () => clock },
    )
    expect(outcome!.messages.at(-1)).toBe(stale)
    expect(estimateContextTokens(outcome!.messages).lastUsageIndex).toBeNull()
    expect(estimateContextTokens(outcome!.messages).tokens).toBeLessThan(1_000)

    // Same millisecond as the summary: identity, not the timestamp, decides.
    const fresh = { ...assistant('new answer', { usage: { input: 5_000, totalTokens: 5_000 } }), timestamp: clock }
    const next = [...outcome!.messages, user('more'), fresh]
    expect(estimateContextTokens(next)).toMatchObject({ usageTokens: 5_000, lastUsageIndex: next.length - 1 })
  })
})

describe('findCutPoint', () => {
  it('never separates a tool call from its result and never cuts the system message', () => {
    const messages = [
      system(),
      user('task'),
      assistant('', { toolCalls: [toolCall('a', 'read_file', { path: 'a' })] }),
      toolResult('a', 'read_file', filler(3_000)),
      assistant('', { toolCalls: [toolCall('b', 'read_file', { path: 'b' })] }),
      toolResult('b', 'read_file', filler(3_000)),
      assistant('done'),
    ]
    const cut = findCutPoint(messages, 1, 4_000)
    expect(messages[cut.firstKeptIndex].role).not.toBe('toolResult')
    expect(cut.firstKeptIndex).toBe(4)
    expect(cut).toMatchObject({ turnStartIndex: 1, isSplitTurn: true })
    expect(findCutPoint(messages, 1, 1_000_000).firstKeptIndex).toBe(1)
  })

  it('cuts at a user message when the budget allows it', () => {
    const messages = [system(), user(filler(2_000)), assistant(filler(2_000)), user('q2'), assistant('a2')]
    expect(findCutPoint(messages, 1, 2)).toEqual({ firstKeptIndex: 3, turnStartIndex: -1, isSplitTurn: false })
  })
})

describe('serializeConversation', () => {
  it('labels roles, truncates tool results and marks images', () => {
    const messages: AgentMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', data: 'AA', mimeType: 'image/png' }], timestamp: 1 },
      assistant('sure', { toolCalls: [toolCall('a', 'shell', { command: 'ls' })] }),
      toolResult('a', 'shell', 'y'.repeat(50)),
    ]
    const text = serializeConversation(messages, 10)
    expect(text).toContain('[User]: look\n[image]')
    expect(text).toContain('[Assistant tool calls]: shell(command="ls")')
    expect(text).toContain('[Tool result]: yyyyyyyyyy\n\n[... 40 more characters truncated]')
  })
})

describe('external actions', () => {
  const messages = [
    user('go'),
    assistant('', {
      toolCalls: [
        toolCall('1', 'read_file', { path: '/a' }),
        toolCall('2', 'shell', { command: 'git push origin feat/x' }),
        toolCall('3', 'shell', { command: 'ls -la' }),
        toolCall('4', 'email_send', { to: ['a@example.com'], subject: 'Hi' }),
      ],
    }),
    toolResult('1', 'read_file', 'content'),
    toolResult('2', 'shell', 'pushed'),
    toolResult('3', 'shell', 'files'),
    toolResult('4', 'email_send', 'Error: blocked', true),
  ]

  it('lists only side-effecting calls with their outcome', () => {
    expect(collectExternalActions(messages)).toEqual([
      '- [done] shell git push origin feat/x',
      '- [failed] email_send {"to":["a@example.com"],"subject":"Hi"}',
    ])
  })

  it('round-trips through the summary and replaces a model-written section', () => {
    const modelWritten = SUMMARY.replace('## Open Threads', `${EXTERNAL_ACTIONS_HEADING}\n- invented\n\n## Open Threads`)
    const summary = insertExternalActions(modelWritten, collectExternalActions(messages))
    expect(summary).not.toContain('invented')
    expect(summary.indexOf(EXTERNAL_ACTIONS_HEADING)).toBeLessThan(summary.indexOf('## Open Threads'))
    expect(parseExternalActions(summary)).toEqual(collectExternalActions(messages))
  })

  it('caps the carried-over list', () => {
    const merged = mergeExternalActions(Array.from({ length: 140 }, (_, i) => `- old ${i}`), Array.from({ length: 20 }, (_, i) => `- new ${i}`))
    expect(merged).toHaveLength(150)
    expect(merged[0]).toBe('- (11 older actions omitted)')
    expect(merged.at(-1)).toBe('- new 19')
  })
})

describe('compactMessages', () => {
  const budget = resolveEffectiveCompactionBudget(
    resolveCompactionSettings('interactive', { keepRecentTokens: 1_000 }),
    100_000,
  )

  function conversation(): AgentMessage[] {
    return [
      system(),
      user('Open a PR for the fix'),
      assistant('', { toolCalls: [toolCall('p1', 'shell', { command: 'gh pr create --title fix' })] }),
      toolResult('p1', 'shell', 'https://github.com/o/r/pull/42'),
      assistant(filler(2_000)),
      user(`Now wait for CI ${filler(600)}`),
      assistant(filler(500)),
    ]
  }

  it('returns [system, summary, ...kept] and keeps the system message by reference', async () => {
    const messages = conversation()
    const calls: RecordedCall[] = []
    const outcome = await compactMessages(messages, { budget, model, streamFn: fakeStreamFn(() => SUMMARY, calls) })

    expect(outcome).not.toBeNull()
    expect(outcome!.messages[0]).toBe(messages[0])
    expect(findSummaryMessage(outcome!.messages)?.summary).toContain('## Goal')
    expect(outcome!.messages.slice(2)).toEqual(messages.slice(5))
    expect(outcome!.summary).toContain('- [done] shell gh pr create --title fix')
    expect(outcome!.tokensAfter).toBeLessThan(outcome!.tokensBefore)
    expect(calls[0].systemPrompt).toBe(SUMMARIZATION_SYSTEM_PROMPT)
    expect(calls[0].maxTokens).toBe(Math.min(budget.summaryMaxTokens, model.maxTokens))
    expect(calls[0].prompt).toContain(`under about ${budget.summaryTargetTokens} tokens`)
    expect(calls[0].prompt).not.toContain('<previous-summary>')
  })

  it('passes the previous summary and carries the action log across compactions', async () => {
    const first = await compactMessages(conversation(), { budget, model, streamFn: fakeStreamFn(() => SUMMARY) })
    const next = [
      ...first!.messages,
      assistant('', { toolCalls: [toolCall('m1', 'email_send', { to: ['ops@example.com'] })] }),
      toolResult('m1', 'email_send', 'sent'),
      assistant(filler(1_500)),
      user(`anything else? ${filler(600)}`),
      assistant(filler(500)),
    ]
    const calls: RecordedCall[] = []
    const second = await compactMessages(next, { budget, model, streamFn: fakeStreamFn(() => SUMMARY, calls) })

    expect(calls[0].prompt).toContain('<previous-summary>')
    expect(calls[0].prompt).toContain('PR #42')
    expect(parseExternalActions(second!.summary)).toEqual([
      '- [done] shell gh pr create --title fix',
      '- [done] email_send {"to":["ops@example.com"]}',
    ])
    expect(findSummaryMessage(second!.messages)?.index).toBe(1)
    expect(second!.messages.filter(m => findSummaryMessage([system(), m]) !== null)).toHaveLength(1)
  })

  it('summarizes a split turn with two calls and merges them', async () => {
    const messages = [
      system(),
      user('first request'),
      assistant(filler(1_500)),
      user('long task'),
      assistant('', { toolCalls: [toolCall('r1', 'read_file', { path: 'a' })] }),
      toolResult('r1', 'read_file', filler(1_500)),
      assistant('', { toolCalls: [toolCall('r2', 'read_file', { path: 'b' })] }),
      toolResult('r2', 'read_file', filler(1_200)),
    ]
    const calls: RecordedCall[] = []
    const outcome = await compactMessages(messages, { budget, model, streamFn: fakeStreamFn((_p, n) => (n === 1 ? SUMMARY : '## Original Request\nlong task'), calls) })

    expect(calls).toHaveLength(2)
    expect(calls[1].prompt).toContain('beginning of a single ongoing request')
    expect(outcome!.summary).toContain('**Turn Context (split turn):**')
    expect(outcome!.messages[2]).toBe(messages[6])
  })

  it('returns null when nothing is old enough to summarize', async () => {
    const outcome = await compactMessages([system(), user('hi'), assistant('hello')], { budget, model, streamFn: fakeStreamFn(() => SUMMARY) })
    expect(outcome).toBeNull()
  })

  it('never summarizes the tool declaration that follows the system prompt', async () => {
    const calls: RecordedCall[] = []
    const short = [system(), toolDeclaration(), user('hi'), assistant(filler(200))]
    expect(await compactMessages(short, { budget, model, streamFn: fakeStreamFn(() => SUMMARY, calls) })).toBeNull()
    expect(calls).toHaveLength(0)

    const messages = [system(), toolDeclaration(), ...conversation().slice(1)]
    const outcome = await compactMessages(messages, { budget, model, streamFn: fakeStreamFn(() => SUMMARY, calls) })
    expect(outcome!.messages[0]).toBe(messages[0])
    expect(outcome!.messages[1]).toBe(messages[1])
    expect(findSummaryMessage(outcome!.messages)?.index).toBe(2)
    expect(outcome!.messages.slice(3)).toEqual(messages.slice(6))
    expect(calls[0].prompt).toContain('Open a PR for the fix')

    const next = [...outcome!.messages, user(`more ${filler(600)}`), assistant(filler(1_500)), user(filler(600)), assistant(filler(500))]
    const second = await compactMessages(next, { budget, model, streamFn: fakeStreamFn(() => SUMMARY, calls) })
    expect(second!.messages[1]).toBe(messages[1])
    expect(findSummaryMessage(second!.messages)?.index).toBe(2)
    expect(calls[1].prompt).toContain('<previous-summary>')
  })

  it('keeps a tool change from the summarized part ahead of the summary', async () => {
    const change = toolDeclaration('generate_image')
    const messages = [system(), toolDeclaration(), user(`draw ${filler(600)}`), assistant(filler(1_500)), change, ...conversation().slice(1)]
    const outcome = await compactMessages(messages, { budget, model, streamFn: fakeStreamFn(() => SUMMARY) })
    expect(outcome!.messages.slice(0, 3)).toEqual([messages[0], messages[1], change])
    expect(findSummaryMessage(outcome!.messages)?.index).toBe(3)
  })

  it('stops when aborted during the summary call', async () => {
    const controller = new AbortController()
    const streamFn = fakeStreamFn(() => {
      controller.abort()
      return SUMMARY
    })
    await expect(compactMessages(conversation(), { budget, model, streamFn, signal: controller.signal }))
      .rejects.toBeInstanceOf(CompactionAbortedError)
  })

  it('refuses a truncated summary', async () => {
    const streamFn: StreamFn = (async () => streamOf({ ...assistant('## Goal\npartial'), stopReason: 'length' })) as StreamFn
    await expect(compactMessages(conversation(), { budget, model, streamFn })).rejects.toThrow(/output limit and is incomplete/)
  })

  it('explains a summary call that spent its whole output limit on reasoning', async () => {
    const thinkingOnly: AssistantMessage = {
      ...assistant(''),
      content: [{ type: 'thinking', thinking: 'Let me think about the conversation...' }],
      stopReason: 'length',
    }
    const streamFn: StreamFn = (async () => streamOf(thinkingOnly)) as StreamFn
    await expect(compactMessages(conversation(), { budget, model, streamFn })).rejects.toThrow(/whole \d+-token output limit for reasoning/)
  })
})
