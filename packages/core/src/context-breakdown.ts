import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { ContextBreakdownSection, ContextUsageBreakdown, SystemPromptSectionKey } from './contracts/compaction.js'
import {
  charsToTokens,
  estimateContextTokens,
  estimateMessageTokens,
  findSummaryMessage,
  systemMessageChars,
} from './compaction.js'
import type { SystemPromptSection } from './memory.js'

// `assistant` last: apportion() falls back to the last bucket.
const CHAT_PARTS = ['summary', 'user', 'toolResults', 'assistant'] as const
type ChatPart = (typeof CHAT_PARTS)[number]

interface Weights {
  sections: number[]
  other: number
  tools: number
  chat: Record<ChatPart, number>
}

function emptyWeights(sectionCount: number): Weights {
  return { sections: new Array<number>(sectionCount).fill(0), other: 0, tools: 0, chat: { summary: 0, user: 0, toolResults: 0, assistant: 0 } }
}

function flatten(weights: Weights): number[] {
  return [...weights.sections, weights.other, weights.tools, ...CHAT_PARTS.map(part => weights.chat[part])]
}

function unflatten(values: number[], sectionCount: number): Weights {
  const chatStart = sectionCount + 2
  return {
    sections: values.slice(0, sectionCount),
    other: values[sectionCount],
    tools: values[sectionCount + 1],
    chat: Object.fromEntries(CHAT_PARTS.map((part, i) => [part, values[chatStart + i]])) as Record<ChatPart, number>,
  }
}

/**
 * Split `total` into integers proportional to `weights` that add up to
 * `total` exactly (largest remainder). Without any weight the total goes to
 * the last entry, which is the bucket of the assistant answer whose usage
 * report produced it.
 */
export function apportion(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((acc, weight) => acc + weight, 0)
  if (weights.length === 0) return []
  if (!(sum > 0)) return weights.map((_, i) => (i === weights.length - 1 ? total : 0))
  const exact = weights.map(weight => (weight / sum) * total)
  const floors = exact.map(Math.floor)
  let remainder = total - floors.reduce((acc, value) => acc + value, 0)
  const byFraction = exact.map((value, i) => ({ i, fraction: value - floors[i] })).sort((a, b) => b.fraction - a.fraction)
  for (const { i } of byFraction) {
    if (remainder <= 0) break
    floors[i]++
    remainder--
  }
  return floors
}

function chatPart(message: AgentMessage, isSummary: boolean): ChatPart | null {
  if (isSummary) return 'summary'
  switch (message.role) {
    case 'user': return 'user'
    case 'assistant': return 'assistant'
    case 'toolResult': return 'toolResults'
    default: return null
  }
}

/**
 * Heuristic token weights of a slice of the transcript. Prompt text of the
 * leading system message (its blocks plus the separators between them) is
 * spread over `sections` by length; other system prompt text counts as `other`.
 */
function weigh(
  messages: readonly AgentMessage[],
  offset: number,
  summaryIndex: number | null,
  sections: readonly SystemPromptSection[] | undefined,
): Weights {
  const weights = emptyWeights(sections?.length ?? 0)
  messages.forEach((message, i) => {
    const index = offset + i
    if (message.role === 'system') {
      const chars = systemMessageChars(message)
      weights.tools += charsToTokens(chars.tools)
      const sectionChars = sections?.reduce((acc, section) => acc + section.text.length, 0) ?? 0
      if (index === 0 && sections && sectionChars > 0) {
        sections.forEach((section, s) => { weights.sections[s] += charsToTokens(chars.prompt * (section.text.length / sectionChars)) })
      } else {
        weights.other += charsToTokens(chars.prompt)
      }
      return
    }
    const part = chatPart(message, index === summaryIndex)
    if (part) weights.chat[part] += estimateMessageTokens(message)
  })
  return weights
}

/**
 * Split the context size the meter shows into system prompt, tool
 * definitions and chat. The provider only reports a total, so the share of
 * every part is the chars/4 heuristic, scaled so the parts covered by the
 * last usage report add up to its measured size; messages after it keep
 * their raw estimate, as in {@link estimateContextTokens}.
 *
 * `systemPromptSections` must be the blocks the leading system message's
 * text was joined from; without them that text counts as `other`.
 */
export function estimateContextBreakdown(
  messages: readonly AgentMessage[],
  systemPromptSections?: readonly SystemPromptSection[],
): ContextUsageBreakdown {
  const estimate = estimateContextTokens(messages)
  const measuredEnd = estimate.lastUsageIndex === null ? 0 : estimate.lastUsageIndex + 1
  const summaryIndex = findSummaryMessage(messages)?.index ?? null
  const sectionCount = systemPromptSections?.length ?? 0

  const measured = apportion(estimate.usageTokens, flatten(weigh(messages.slice(0, measuredEnd), 0, summaryIndex, systemPromptSections)))
  const trailing = apportion(estimate.trailingTokens, flatten(weigh(messages.slice(measuredEnd), measuredEnd, summaryIndex, systemPromptSections)))
  const parts = unflatten(measured.map((value, i) => value + trailing[i]), sectionCount)

  const sectionTokens = new Map<SystemPromptSectionKey, number>()
  systemPromptSections?.forEach((section, i) => {
    sectionTokens.set(section.key, (sectionTokens.get(section.key) ?? 0) + parts.sections[i])
  })
  sectionTokens.set('other', (sectionTokens.get('other') ?? 0) + parts.other)
  const sections: ContextBreakdownSection[] = [...sectionTokens]
    .filter(([, tokens]) => tokens > 0)
    .map(([key, tokens]) => ({ key, tokens }))
    .sort((a, b) => b.tokens - a.tokens)

  return {
    systemPrompt: { tokens: sections.reduce((acc, section) => acc + section.tokens, 0), sections },
    toolDefinitions: { tokens: parts.tools, count: countDeclaredTools(messages) },
    chat: { tokens: CHAT_PARTS.reduce((acc, part) => acc + parts.chat[part], 0), ...parts.chat },
  }
}

/** Tools the model can call after replaying every declaration in the transcript. */
function countDeclaredTools(messages: readonly AgentMessage[]): number {
  const names = new Set<string>()
  for (const message of messages) {
    if (message.role !== 'system') continue
    for (const tool of message.toolsRemoved ?? []) names.delete(tool.name)
    for (const tool of message.toolsAdded ?? []) names.add(tool.name)
  }
  return names.size
}
