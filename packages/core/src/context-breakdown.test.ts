import { describe, expect, it } from 'vitest'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai'
import type { AssistantMessage, Tool, Usage } from '@earendil-works/pi-ai'
import { apportion, estimateContextBreakdown } from './context-breakdown.js'
import type { ContextUsageBreakdown } from './contracts/compaction.js'
import { estimateContextTokens } from './compaction.js'
import type { SystemPromptSection } from './memory.js'

const SECTIONS: SystemPromptSection[] = [
  { key: 'personality', text: `<personality>\n${'p'.repeat(400)}\n</personality>` },
  { key: 'core_memory', text: `<core_memory>\n${'m'.repeat(4_000)}\n</core_memory>` },
  { key: 'available_skills', text: `<available_skills>\n${'s'.repeat(1_600)}\n</available_skills>` },
]
const PROMPT = SECTIONS.map(section => section.text).join('\n\n')

const TOOL: Tool = {
  name: 'web_fetch',
  description: 'Fetch a web page.',
  parameters: { type: 'object', properties: { url: { type: 'string', description: 'x'.repeat(2_000) } } } as Tool['parameters'],
}

let clock = 0

function system(content: string, tools: Tool[] = [TOOL]): AgentMessage {
  return { role: 'system', content, toolsAdded: tools, timestamp: 0 }
}

function user(chars: number): AgentMessage {
  return { role: 'user', content: [{ type: 'text', text: 'u'.repeat(chars) }], timestamp: ++clock }
}

function usage(input: number, output: number): Usage {
  return { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
}

function answer(chars: number, reported?: Usage): AssistantMessage {
  const message = { ...fauxAssistantMessage('a'.repeat(chars)), timestamp: ++clock }
  return reported ? { ...message, usage: reported } : message
}

function toolTurn(resultChars: number): AgentMessage[] {
  return [
    { ...fauxAssistantMessage(fauxToolCall('web_fetch', { url: 'https://example.com' }, { id: 'call-1' }), { stopReason: 'toolUse' }), timestamp: ++clock },
    { role: 'toolResult', toolCallId: 'call-1', toolName: 'web_fetch', content: [{ type: 'text', text: 'r'.repeat(resultChars) }], isError: false, timestamp: ++clock },
  ]
}

function partsTotal(breakdown: ContextUsageBreakdown): number {
  return breakdown.systemPrompt.tokens + breakdown.toolDefinitions.tokens + breakdown.chat.tokens
}

describe('apportion', () => {
  it('splits a total proportionally into integers that add up exactly', () => {
    expect(apportion(10, [1, 1, 1])).toEqual([4, 3, 3])
    expect(apportion(100, [3, 1])).toEqual([75, 25])
    expect(apportion(7, [0.5, 0.25, 0.25]).reduce((a, b) => a + b, 0)).toBe(7)
  })

  it('puts a total without any weight into the last bucket', () => {
    expect(apportion(5, [0, 0, 0])).toEqual([0, 0, 5])
    expect(apportion(0, [])).toEqual([])
  })
})

describe('estimateContextBreakdown', () => {
  it('splits an unmeasured transcript by the chars/4 heuristic and adds up to the estimate', () => {
    const messages = [system(PROMPT), user(800), answer(1_200), ...toolTurn(4_000)]
    const breakdown = estimateContextBreakdown(messages, SECTIONS)

    expect(partsTotal(breakdown)).toBe(estimateContextTokens(messages).tokens)
    expect(breakdown.systemPrompt.sections.map(section => section.key)).toEqual(['core_memory', 'available_skills', 'personality'])
    expect(breakdown.systemPrompt.sections.reduce((sum, section) => sum + section.tokens, 0)).toBe(breakdown.systemPrompt.tokens)
    const memory = breakdown.systemPrompt.sections[0].tokens
    expect(memory).toBeGreaterThanOrEqual(1_000)
    expect(memory).toBeLessThanOrEqual(1_010)
    expect(breakdown.toolDefinitions).toMatchObject({ count: 1 })
    expect(breakdown.toolDefinitions.tokens).toBeGreaterThan(500)
    expect(breakdown.chat.toolResults).toBeGreaterThanOrEqual(1_000)
    expect(breakdown.chat.user).toBeGreaterThanOrEqual(200)
    expect(breakdown.chat.summary).toBe(0)
    expect(breakdown.chat.tokens).toBe(breakdown.chat.user + breakdown.chat.assistant + breakdown.chat.toolResults)
  })

  it('scales the parts a usage report covers to the measured size and keeps later messages estimated', () => {
    const heuristic = estimateContextBreakdown([system(PROMPT), user(800), answer(1_200)], SECTIONS)
    const covered = [system(PROMPT), user(800), answer(1_200, usage(9_000, 1_000))]
    const measured = estimateContextBreakdown(covered, SECTIONS)
    const withLater = estimateContextBreakdown([...covered, user(4_000)], SECTIONS)

    expect(partsTotal(measured)).toBe(10_000)
    expect(measured.systemPrompt.tokens / heuristic.systemPrompt.tokens).toBeCloseTo(10_000 / partsTotal(heuristic), 2)
    expect(measured.systemPrompt.sections.map(section => section.key)).toEqual(heuristic.systemPrompt.sections.map(section => section.key))
    expect(partsTotal(withLater)).toBe(10_000 + 1_000)
    expect(withLater.chat.user - measured.chat.user).toBe(1_000)
  })

  it('counts the whole system prompt as other without matching sections', () => {
    const breakdown = estimateContextBreakdown([system('custom prompt '.repeat(100)), user(400)])
    expect(breakdown.systemPrompt.sections).toEqual([{ key: 'other', tokens: breakdown.systemPrompt.tokens }])
  })

  it('reports the compaction summary separately and counts tools still declared', () => {
    const summary: AgentMessage = { role: 'user', content: [{ type: 'text', text: `<context_summary>\n${'s'.repeat(2_000)}\n</context_summary>` }], timestamp: ++clock }
    const removal: AgentMessage = { role: 'system', content: '', toolsAdded: [{ ...TOOL, name: 'shell' }], toolsRemoved: [{ name: 'web_fetch' }], timestamp: ++clock }
    const breakdown = estimateContextBreakdown([system(PROMPT), summary, user(400), removal, answer(400)], SECTIONS)

    expect(breakdown.chat.summary).toBeGreaterThanOrEqual(500)
    expect(breakdown.chat.user).toBeLessThan(150)
    expect(breakdown.toolDefinitions.count).toBe(1)
  })
})
