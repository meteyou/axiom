/**
 * Context compaction: replace the older part of an agent transcript with an
 * LLM-written summary so long runs stay inside the model's context window.
 *
 * Token estimation, cut-point selection, conversation serialization and the
 * summary prompts are ported from pi coding agent
 * (@earendil-works/pi-coding-agent 1.0.3, dist/core/compaction/{compaction,utils}.js),
 * MIT License, Copyright (c) Mario Zechner. Adapted to work on a flat
 * `AgentMessage[]` transcript whose first entry is the system message, and
 * extended with window-relative budgets and a deterministic record of
 * side-effecting tool calls.
 */
import type { AgentMessage, StreamFn } from '@earendil-works/pi-agent-core'
import { normalizeContext, retryAssistantCall } from '@earendil-works/pi-ai'
import type {
  Api,
  AssistantMessage,
  ImageContent,
  Model,
  RetryPolicy,
  SystemMessage,
  TextContent,
  ToolCall,
  Usage,
} from '@earendil-works/pi-ai'
import { DEFAULT_COMPACTION_SETTINGS } from './contracts/settings.js'
import type { SettingsStorageContract } from './contracts/settings.js'
import { COMPACTION_SCOPES } from './contracts/providers.js'
import type { CompactionScopeContract } from './contracts/providers.js'
import type { ContextCompactionReason } from './contracts/compaction.js'
import { getToolReplayPolicy } from './tool-replay.js'

export type CompactionScope = CompactionScopeContract
export type CompactionReason = ContextCompactionReason

/** `settings.json → compaction` as stored; the token fields are optional file-only tuning. */
export type CompactionSettingsSource = NonNullable<SettingsStorageContract['compaction']>

export interface ResolvedCompactionSettings {
  enabled: boolean
  reserveTokens: number
  keepRecentTokens: number
}

/** Budgets after capping the configured values against the model's window. */
export interface EffectiveCompactionBudget {
  contextWindow: number
  reserveTokens: number
  /** Compaction runs once the context grows beyond this many tokens. */
  triggerTokens: number
  keepRecentTokens: number
  /** Length the summary is asked to stay under. */
  summaryTargetTokens: number
  /** Output ceiling of the summary call; includes room for reasoning tokens. */
  summaryMaxTokens: number
}

export interface CompactionInvariantCheck {
  ok: boolean
  /** System prompt + summary + kept tail. */
  requiredTokens: number
  /** Share of the trigger that must stay free after a compaction. */
  budgetTokens: number
}

const DEFAULT_RESERVE_TOKENS = 16_384
const DEFAULT_KEEP_RECENT_TOKENS = 20_000
const SUMMARY_TARGET_TOKENS = 8_192
const TOOL_RESULT_MAX_CHARS = 2_000

const RESERVE_WINDOW_SHARE = 0.25
const KEEP_TRIGGER_SHARE = 0.3
const SUMMARY_TRIGGER_SHARE = 0.15
const SUMMARY_RESERVE_SHARE = 0.8
const POST_COMPACTION_TRIGGER_SHARE = 0.6

/** Rough system-prompt sizes used where the real prompt is not at hand (provider UI warnings). */
export const TYPICAL_SYSTEM_PROMPT_TOKENS: Readonly<Record<CompactionScope, number>> = {
  interactive: 35_000,
  task: 4_000,
}

function readTokenSetting(
  settings: CompactionSettingsSource | undefined,
  key: 'reserveTokens' | 'keepRecentTokens',
  fallback: number,
): number {
  const value = settings?.[key]
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`settings.json: compaction.${key} must be a positive integer, got ${JSON.stringify(value)}`)
  }
  return value
}

/** `enabled` is a master switch: tasks additionally need `compaction.tasks.enabled`. */
export function resolveCompactionSettings(
  scope: CompactionScope,
  settings: CompactionSettingsSource | undefined,
): ResolvedCompactionSettings {
  const globallyEnabled = settings?.enabled ?? DEFAULT_COMPACTION_SETTINGS.enabled
  const tasksEnabled = settings?.tasks?.enabled ?? DEFAULT_COMPACTION_SETTINGS.tasks.enabled
  return {
    enabled: globallyEnabled && (scope !== 'task' || tasksEnabled),
    reserveTokens: readTokenSetting(settings, 'reserveTokens', DEFAULT_RESERVE_TOKENS),
    keepRecentTokens: readTokenSetting(settings, 'keepRecentTokens', DEFAULT_KEEP_RECENT_TOKENS),
  }
}

/**
 * Cap the budgets relative to the context window `W`. Without the caps a
 * small window (e.g. 40k) would keep more tail than the trigger leaves room
 * for and compact again on every turn.
 */
export function resolveEffectiveCompactionBudget(
  settings: ResolvedCompactionSettings,
  contextWindow: number,
): EffectiveCompactionBudget {
  const reserveTokens = Math.min(settings.reserveTokens, Math.floor(RESERVE_WINDOW_SHARE * contextWindow))
  const triggerTokens = contextWindow - reserveTokens
  const summaryTargetTokens = Math.min(SUMMARY_TARGET_TOKENS, Math.floor(SUMMARY_TRIGGER_SHARE * triggerTokens))
  return {
    contextWindow,
    reserveTokens,
    triggerTokens,
    keepRecentTokens: Math.min(settings.keepRecentTokens, Math.floor(KEEP_TRIGGER_SHARE * triggerTokens)),
    summaryTargetTokens,
    // Reasoning models spend part of the ceiling on thinking that cannot always
    // be switched off (e.g. custom OpenAI-compatible gateways).
    summaryMaxTokens: Math.max(summaryTargetTokens, Math.floor(SUMMARY_RESERVE_SHARE * reserveTokens)),
  }
}

/** After a compaction the context must leave headroom, or the next turn compacts again. */
export function checkCompactionInvariant(
  budget: EffectiveCompactionBudget,
  systemPromptTokens: number,
): CompactionInvariantCheck {
  const requiredTokens = systemPromptTokens + budget.summaryTargetTokens + budget.keepRecentTokens
  const budgetTokens = Math.floor(POST_COMPACTION_TRIGGER_SHARE * budget.triggerTokens)
  return { ok: requiredTokens <= budgetTokens, requiredTokens, budgetTokens }
}

/**
 * Agent kinds for which a model's window cannot hold a typical system prompt
 * plus the compaction summary and kept tail with enough headroom.
 */
export function getCompactionWarningScopes(
  contextWindow: number,
  settings: CompactionSettingsSource | undefined,
): CompactionScope[] {
  if (!(contextWindow > 0)) return []
  return COMPACTION_SCOPES.filter((scope) => {
    const resolved = resolveCompactionSettings(scope, settings)
    if (!resolved.enabled) return false
    const budget = resolveEffectiveCompactionBudget(resolved, contextWindow)
    return !checkCompactionInvariant(budget, TYPICAL_SYSTEM_PROMPT_TOKENS[scope]).ok
  })
}

export function shouldCompact(contextTokens: number, budget: EffectiveCompactionBudget, enabled = true): boolean {
  return enabled && contextTokens > budget.triggerTokens
}

const CHARS_PER_TOKEN = 4
export const IMAGE_TOKEN_ESTIMATE = 1_500

function contentChars(content: string | readonly (TextContent | ImageContent)[]): { chars: number; images: number } {
  if (typeof content === 'string') return { chars: content.length, images: 0 }
  let chars = 0
  let images = 0
  for (const block of content) {
    if (block.type === 'text') chars += block.text.length
    else if (block.type === 'image') images++
  }
  return { chars, images }
}

function assistantChars(message: AssistantMessage): number {
  let chars = 0
  for (const block of message.content) {
    if (block.type === 'text') chars += block.text.length
    else if (block.type === 'thinking') chars += block.thinking.length
    else if (block.type === 'toolCall') chars += block.name.length + JSON.stringify(block.arguments ?? {}).length
  }
  return chars
}

/** Character count of the prompt text and of the tool declarations a system message carries. */
export function systemMessageChars(message: SystemMessage): { prompt: number; tools: number } {
  let prompt = contentChars(message.content).chars
  for (const section of Object.values(message.sections ?? {})) {
    if (section) prompt += section.length
  }
  const tools = message.toolsAdded ? JSON.stringify(message.toolsAdded).length : 0
  return { prompt, tools }
}

/** Unrounded chars/4 estimate, for splitting a total into shares. */
export function charsToTokens(chars: number): number {
  return chars / CHARS_PER_TOKEN
}

/** chars/4 heuristic; deliberately on the high side. */
export function estimateMessageTokens(message: AgentMessage): number {
  switch (message.role) {
    case 'system': {
      const { prompt, tools } = systemMessageChars(message)
      return Math.ceil(charsToTokens(prompt + tools))
    }
    case 'user':
    case 'toolResult': {
      const { chars, images } = contentChars(message.content)
      return Math.ceil(chars / CHARS_PER_TOKEN) + images * IMAGE_TOKEN_ESTIMATE
    }
    case 'assistant':
      return Math.ceil(assistantChars(message) / CHARS_PER_TOKEN)
    default:
      return 0
  }
}

export function estimateMessagesTokens(messages: readonly AgentMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0)
}

function usageContextTokens(usage: Usage): number {
  return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite
}

/**
 * Assistant messages kept verbatim by a compaction. Their usage describes the
 * transcript before it was shortened. Tracked by identity: the first answer
 * after a compaction can share the summary's millisecond timestamp.
 */
const staleUsage = new WeakSet<AgentMessage>()

function trustedUsage(message: AgentMessage): Usage | undefined {
  if (message.role !== 'assistant' || staleUsage.has(message)) return undefined
  if (message.stopReason === 'aborted' || message.stopReason === 'error') return undefined
  if (!message.usage || usageContextTokens(message.usage) <= 0) return undefined
  return message.usage
}

/**
 * Provider-reported size of the request that produced `message`: everything
 * before it as the provider tokenized it. Null when the message carries no
 * usable usage.
 */
export function requestContextTokens(message: AgentMessage): number | null {
  const usage = trustedUsage(message)
  if (!usage) return null
  const tokens = usage.input + usage.cacheRead + usage.cacheWrite
  return tokens > 0 ? tokens : null
}

export interface ContextTokenEstimate {
  tokens: number
  usageTokens: number
  trailingTokens: number
  lastUsageIndex: number | null
}

/**
 * Context size = the provider-reported usage of the last assistant message
 * plus a heuristic for everything after it. Usage of messages a compaction
 * kept describes the old transcript and is ignored.
 */
export function estimateContextTokens(messages: readonly AgentMessage[]): ContextTokenEstimate {
  for (let i = messages.length - 1; i >= 0; i--) {
    const usage = trustedUsage(messages[i])
    if (!usage) continue
    const trailingTokens = estimateMessagesTokens(messages.slice(i + 1))
    const usageTokens = usageContextTokens(usage)
    return { tokens: usageTokens + trailingTokens, usageTokens, trailingTokens, lastUsageIndex: i }
  }

  const tokens = estimateMessagesTokens(messages)
  return { tokens, usageTokens: 0, trailingTokens: tokens, lastUsageIndex: null }
}

const SUMMARY_OPEN_TAG = '<context_summary>'
const SUMMARY_CLOSE_TAG = '</context_summary>'
const SUMMARY_PREAMBLE = 'The earlier part of this conversation was compacted into the summary below. '
  + 'It replaces those messages; continue the work from here.'

function messageText(message: AgentMessage): string {
  if (message.role !== 'user' && message.role !== 'toolResult' && message.role !== 'system') return ''
  const content: string | readonly (TextContent | ImageContent)[] = message.content
  if (typeof content === 'string') return content
  return content.filter((block): block is TextContent => block.type === 'text').map(block => block.text).join('')
}

function buildSummaryMessage(summary: string, timestamp: number): AgentMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text: `${SUMMARY_OPEN_TAG}\n${SUMMARY_PREAMBLE}\n\n${summary}\n${SUMMARY_CLOSE_TAG}` }],
    timestamp,
  }
}

/**
 * Index of the first non-system message. pi-agent-core declares tools in a
 * system message of its own right after the system prompt, so the leading
 * run is usually longer than one message.
 */
function leadingSystemEnd(messages: readonly AgentMessage[]): number {
  let index = 0
  while (index < messages.length && messages[index].role === 'system') index++
  return index
}

/** System prompt plus the tool declarations that precede the conversation. */
export function estimateSystemTokens(messages: readonly AgentMessage[]): number {
  return estimateMessagesTokens(messages.slice(0, leadingSystemEnd(messages)))
}

/** The summary of the previous compaction directly follows the leading system messages. */
export function findSummaryMessage(
  messages: readonly AgentMessage[],
): { index: number; message: AgentMessage; summary: string } | null {
  const index = leadingSystemEnd(messages)
  const message = messages[index]
  if (!message || message.role !== 'user') return null
  const text = messageText(message).trim()
  if (!text.startsWith(SUMMARY_OPEN_TAG) || !text.endsWith(SUMMARY_CLOSE_TAG)) return null
  const body = text.slice(SUMMARY_OPEN_TAG.length, -SUMMARY_CLOSE_TAG.length).trim()
  const summary = body.startsWith(SUMMARY_PREAMBLE) ? body.slice(SUMMARY_PREAMBLE.length).trim() : body
  return { index, message, summary }
}

export interface CutPoint {
  /** Index of the first message that is kept verbatim. */
  firstKeptIndex: number
  /** User message that started the turn the cut lands in (split turns only), else -1. */
  turnStartIndex: number
  isSplitTurn: boolean
}

function isCutPoint(message: AgentMessage): boolean {
  return message.role === 'user' || message.role === 'assistant'
}

/**
 * Walk backwards from the newest message until `keepRecentTokens` are
 * collected and cut there. Cuts land on user or assistant messages only, so a
 * tool call and its result always stay on the same side. Only messages from
 * `startIndex` on are considered; everything before (system message, previous
 * summary) is never cut away.
 */
export function findCutPoint(
  messages: readonly AgentMessage[],
  startIndex: number,
  keepRecentTokens: number,
): CutPoint {
  const cutPoints: number[] = []
  for (let i = startIndex; i < messages.length; i++) {
    if (isCutPoint(messages[i])) cutPoints.push(i)
  }
  if (cutPoints.length === 0) return { firstKeptIndex: startIndex, turnStartIndex: -1, isSplitTurn: false }

  let accumulated = 0
  let cutIndex = cutPoints[0]
  for (let i = messages.length - 1; i >= startIndex; i--) {
    const tokens = estimateMessageTokens(messages[i])
    if (tokens === 0) continue
    accumulated += tokens
    if (accumulated >= keepRecentTokens) {
      // A run of tool results larger than the budget keeps its assistant call
      // instead of falling back to "keep everything".
      cutIndex = cutPoints.find(candidate => candidate >= i) ?? cutPoints[cutPoints.length - 1]
      break
    }
  }

  if (messages[cutIndex].role === 'user') return { firstKeptIndex: cutIndex, turnStartIndex: -1, isSplitTurn: false }

  let turnStartIndex = -1
  for (let i = cutIndex; i >= startIndex; i--) {
    if (messages[i].role === 'user') {
      turnStartIndex = i
      break
    }
  }
  return { firstKeptIndex: cutIndex, turnStartIndex, isSplitTurn: turnStartIndex !== -1 }
}

function truncateForSummary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n\n[... ${text.length - maxChars} more characters truncated]`
}

function contentForSummary(content: string | readonly (TextContent | ImageContent)[]): string {
  if (typeof content === 'string') return content
  return content.map(block => (block.type === 'text' ? block.text : '[image]')).join('\n')
}

function formatToolCall(call: ToolCall): string {
  const args = Object.entries(call.arguments ?? {})
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(', ')
  return `${call.name}(${args})`
}

/**
 * Render messages as a labelled transcript. Serializing (instead of passing
 * real messages) keeps the summarizer from continuing the conversation.
 */
export function serializeConversation(messages: readonly AgentMessage[], toolResultMaxChars: number): string {
  const parts: string[] = []
  for (const message of messages) {
    if (message.role === 'user') {
      const text = contentForSummary(message.content)
      if (text) parts.push(`[User]: ${text}`)
    } else if (message.role === 'assistant') {
      const thinking = message.content.filter(block => block.type === 'thinking').map(block => block.thinking)
      const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('')
      const toolCalls = message.content.filter((block): block is ToolCall => block.type === 'toolCall')
      if (thinking.length > 0) parts.push(`[Assistant thinking]: ${thinking.join('\n')}`)
      if (text) parts.push(`[Assistant]: ${text}`)
      if (toolCalls.length > 0) parts.push(`[Assistant tool calls]: ${toolCalls.map(formatToolCall).join('; ')}`)
    } else if (message.role === 'toolResult') {
      const text = contentForSummary(message.content)
      if (text) {
        const label = message.isError ? '[Tool error]' : '[Tool result]'
        parts.push(`${label}: ${truncateForSummary(text, toolResultMaxChars)}`)
      }
    }
  }
  return parts.join('\n\n')
}

export const EXTERNAL_ACTIONS_HEADING = '## External Actions Already Performed'
const MAX_EXTERNAL_ACTIONS = 150
const ACTION_ARGS_PREVIEW_CHARS = 200

/** Read-only or purely local commands are noise in the action log; only these count. */
const SIDE_EFFECT_SHELL_PATTERN = new RegExp([
  String.raw`\bgit\s+(push|commit|tag|merge|rebase|reset|cherry-pick|revert)\b`,
  String.raw`\bgh\s+(pr|issue|release|repo|gist|workflow|run|label|api)\b`,
  String.raw`\bcurl\b[^|;&]*(-X\s*(POST|PUT|PATCH|DELETE)|--data|\s-d\s|--form|\s-F\s)`,
  String.raw`\b(npm|pnpm|yarn)\s+publish\b`,
  String.raw`\bdocker\s+(push|run|rm|stop|compose)\b`,
  String.raw`\b(systemctl|service)\s+(start|stop|restart|enable|disable)\b`,
  String.raw`\bkubectl\s+(apply|delete|create|patch|scale|rollout)\b`,
  String.raw`\b(rm|mv|rsync|scp|ssh|sendmail|mail)\b`,
].join('|'), 'i')

function isSideEffectingCall(call: ToolCall): boolean {
  if (getToolReplayPolicy(call.name) === 'safe') return false
  if (call.name !== 'shell') return true
  const command = typeof call.arguments?.command === 'string' ? call.arguments.command : ''
  return SIDE_EFFECT_SHELL_PATTERN.test(command)
}

function oneLine(text: string, maxChars: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > maxChars ? `${flat.slice(0, maxChars)}…` : flat
}

function describeAction(call: ToolCall, outcome: string): string {
  const args = call.name === 'shell' && typeof call.arguments?.command === 'string'
    ? call.arguments.command
    : JSON.stringify(call.arguments ?? {})
  return `- [${outcome}] ${call.name} ${oneLine(args, ACTION_ARGS_PREVIEW_CHARS)}`
}

/** One line per side-effecting tool call, oldest first, with its outcome. */
export function collectExternalActions(messages: readonly AgentMessage[]): string[] {
  const outcomes = new Map<string, string>()
  for (const message of messages) {
    if (message.role === 'toolResult') outcomes.set(message.toolCallId, message.isError ? 'failed' : 'done')
  }
  const lines: string[] = []
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const block of message.content) {
      if (block.type !== 'toolCall' || !isSideEffectingCall(block)) continue
      lines.push(describeAction(block, outcomes.get(block.id) ?? 'outcome unknown'))
    }
  }
  return lines
}

/** Re-read the action lines a previous compaction wrote, so they carry over. */
export function parseExternalActions(summary: string | undefined): string[] {
  if (!summary) return []
  const start = summary.indexOf(EXTERNAL_ACTIONS_HEADING)
  if (start === -1) return []
  const lines: string[] = []
  for (const line of summary.slice(start + EXTERNAL_ACTIONS_HEADING.length).split('\n')) {
    if (line.startsWith('## ') || line.startsWith('---')) break
    if (line.startsWith('- ')) lines.push(line)
  }
  return lines
}

export function mergeExternalActions(previous: readonly string[], current: readonly string[]): string[] {
  const merged = [...previous, ...current]
  if (merged.length <= MAX_EXTERNAL_ACTIONS) return merged
  const kept = merged.slice(-(MAX_EXTERNAL_ACTIONS - 1))
  return [`- (${merged.length - kept.length} older actions omitted)`, ...kept]
}

function renderExternalActions(actions: readonly string[]): string {
  const body = actions.length > 0 ? actions.join('\n') : '- (none)'
  return `${EXTERNAL_ACTIONS_HEADING}\nThese already happened. Do not repeat them; verify their state first if in doubt.\n${body}`
}

function stripSection(text: string, heading: string): string {
  const start = text.indexOf(heading)
  if (start === -1) return text
  const rest = text.slice(start + heading.length)
  const next = rest.search(/\n## /)
  return (text.slice(0, start) + (next === -1 ? '' : rest.slice(next + 1))).trim()
}

/** Insert the deterministic action log before "Open Threads", replacing anything the model wrote there. */
export function insertExternalActions(summary: string, actions: readonly string[]): string {
  const cleaned = stripSection(summary, EXTERNAL_ACTIONS_HEADING)
  const section = renderExternalActions(actions)
  const anchor = cleaned.indexOf('## Open Threads')
  if (anchor === -1) return `${cleaned}\n\n${section}`
  return `${cleaned.slice(0, anchor).trimEnd()}\n\n${section}\n\n${cleaned.slice(anchor)}`
}

export const SUMMARIZATION_SYSTEM_PROMPT = 'You are a context summarization assistant. Your task is to read a '
  + 'conversation between a user and an AI assistant, then produce a structured summary following the exact '
  + 'format specified.\n\nDo NOT continue the conversation. Do NOT respond to any questions in the conversation. '
  + 'ONLY output the structured summary.'

const SUMMARY_FORMAT = `## Goal
[What the user is trying to accomplish. Can be several items.]

## Constraints & Preferences
- [Requirements and preferences the user stated, or "(none)"]

## Progress
### Done
- [x] [Completed work]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Open Threads & Next Steps
1. [What should happen next, open questions, unanswered requests]

## Critical Context
- [Exact IDs, URLs, file paths, branch names, PR/issue numbers, task IDs, error messages needed to continue]`

const FORMAT_RULES = `Do not write an "External Actions Already Performed" section; it is generated separately.
Keep each section concise. Preserve exact identifiers, file paths, URLs and error messages.`

const INITIAL_SUMMARY_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

${SUMMARY_FORMAT}

${FORMAT_RULES}`

const UPDATE_SUMMARY_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Open Threads & Next Steps" based on what was accomplished
- If something is no longer relevant, you may remove it

Use this EXACT format:

${SUMMARY_FORMAT}

${FORMAT_RULES}`

const TURN_PREFIX_PROMPT = `The messages above are the beginning of a single ongoing request. Later messages are kept separately and do not need to be reconstructed.

Create a concise checkpoint of the request and the progress shown above:

## Original Request
[What was asked for?]

## Progress So Far
- [Key decisions and work completed in these messages]

## Context Needed to Continue
- [Exact identifiers, paths and results the later messages rely on]

Only summarize information explicitly present above.`

interface SummaryResult {
  text: string
  usage: Usage
}

export interface GenerateSummaryOptions {
  messages: readonly AgentMessage[]
  previousSummary?: string
  customInstructions?: string
  /** `turnPrefix` summarizes the start of a turn that is cut in the middle. */
  mode?: 'history' | 'turnPrefix'
  model: Model<Api>
  apiKey?: string
  streamFn: StreamFn
  /** Output ceiling of the call, reasoning included. */
  maxTokens: number
  /** Length the summary is asked to stay under. */
  targetTokens: number
  signal?: AbortSignal
  sessionId?: string
  retryPolicy?: RetryPolicy
  /** Called whenever the summary call shows signs of life (request start, streamed events). */
  onProgress?: () => void
}

export class CompactionAbortedError extends Error {
  constructor() {
    super('Compaction aborted')
    this.name = 'CompactionAbortedError'
  }
}

function buildSummaryPrompt(options: GenerateSummaryOptions): string {
  const conversation = serializeConversation(options.messages, TOOL_RESULT_MAX_CHARS)
  const lengthRule = `\n\nKeep the whole summary under about ${options.targetTokens} tokens.`
  if (options.mode === 'turnPrefix') {
    return `<conversation>\n${conversation}\n</conversation>\n\n${TURN_PREFIX_PROMPT}${lengthRule}`
  }

  let prompt = `<conversation>\n${conversation}\n</conversation>\n\n`
  if (options.previousSummary) prompt += `<previous-summary>\n${options.previousSummary}\n</previous-summary>\n\n`
  prompt += options.previousSummary ? UPDATE_SUMMARY_PROMPT : INITIAL_SUMMARY_PROMPT
  prompt += lengthRule
  if (options.customInstructions) prompt += `\n\nAdditional focus: ${options.customInstructions}`
  return prompt
}

function outputTokenLimit(model: Model<Api>, requested: number): number {
  return Math.max(1, Math.min(requested, model.maxTokens > 0 ? model.maxTokens : requested))
}

/** One summarization call. Never persists anything; throws on error, abort or a truncated summary. */
async function generateSummary(options: GenerateSummaryOptions): Promise<SummaryResult> {
  const context = normalizeContext({
    systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: [{ type: 'text', text: buildSummaryPrompt(options) }], timestamp: Date.now() }],
  })
  const requestOptions = {
    apiKey: options.apiKey,
    maxTokens: outputTokenLimit(options.model, options.maxTokens),
    signal: options.signal,
    sessionId: options.sessionId,
    // One-off prompt: writing it to the prompt cache would only cost money.
    cacheRetention: 'none' as const,
  }
  const produce = async (): Promise<AssistantMessage> => {
    options.onProgress?.()
    const stream = await options.streamFn(options.model, context, requestOptions)
    for await (const _event of stream) options.onProgress?.()
    return stream.result()
  }
  const response = options.retryPolicy
    ? await retryAssistantCall(produce, options.retryPolicy, options.signal)
    : await produce()

  if (response.stopReason === 'aborted' || options.signal?.aborted) throw new CompactionAbortedError()
  if (response.stopReason === 'error') throw new Error(`Summarization failed: ${response.errorMessage || 'Unknown error'}`)
  if (response.content.some(block => block.type === 'toolCall')) throw new Error('Summarization attempted to call a tool')

  const text = response.content.filter((block): block is TextContent => block.type === 'text').map(block => block.text).join('').trim()
  if (response.stopReason === 'length') {
    const limit = requestOptions.maxTokens
    throw new Error(text
      ? `Summarization failed: the summary hit the ${limit}-token output limit and is incomplete`
      : `Summarization failed: the model used its whole ${limit}-token output limit for reasoning before writing the summary. `
        + 'Map the "off" thinking level for this model in the provider settings, or raise compaction.reserveTokens in settings.json.')
  }
  if (!text) throw new Error('Summarization returned an empty summary')
  return { text, usage: response.usage }
}

function addUsage(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    totalTokens: a.totalTokens + b.totalTokens,
    cost: {
      input: a.cost.input + b.cost.input,
      output: a.cost.output + b.cost.output,
      cacheRead: a.cost.cacheRead + b.cost.cacheRead,
      cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite,
      total: a.cost.total + b.cost.total,
    },
  }
}

export interface CompactMessagesOptions extends Omit<GenerateSummaryOptions, 'messages' | 'previousSummary' | 'mode' | 'maxTokens' | 'targetTokens'> {
  budget: EffectiveCompactionBudget
  now?: () => number
}

export interface CompactionOutcome {
  /** `[system, summary, ...kept]` */
  messages: AgentMessage[]
  summary: string
  externalActions: string[]
  usage: Usage
  tokensBefore: number
  tokensAfter: number
  firstKeptTimestamp: number | null
  summarizedMessageCount: number
}

interface CompactionPlan {
  head: AgentMessage[]
  previousSummary?: string
  toSummarize: AgentMessage[]
  turnPrefix: AgentMessage[]
  kept: AgentMessage[]
}

/** Split the transcript into what stays, what gets summarized and what is never touched. */
function planCompaction(messages: readonly AgentMessage[], keepRecentTokens: number): CompactionPlan | null {
  const leadingEnd = leadingSystemEnd(messages)
  const previous = findSummaryMessage(messages)
  const startIndex = previous ? previous.index + 1 : leadingEnd
  const cut = findCutPoint(messages, startIndex, keepRecentTokens)
  const historyEnd = cut.isSplitTurn ? cut.turnStartIndex : cut.firstKeptIndex
  const isConversation = (message: AgentMessage) => message.role !== 'system'
  const toSummarize = messages.slice(startIndex, historyEnd).filter(isConversation)
  const turnPrefix = cut.isSplitTurn ? messages.slice(cut.turnStartIndex, cut.firstKeptIndex).filter(isConversation) : []
  if (toSummarize.length === 0 && turnPrefix.length === 0) return null
  // System messages carry tool declarations and prompt updates; summarizing
  // them away would drop the tools from the transcript.
  const movedSystem = messages.slice(startIndex, cut.firstKeptIndex).filter(message => !isConversation(message))
  return {
    head: [...messages.slice(0, leadingEnd), ...movedSystem],
    previousSummary: previous?.summary,
    toSummarize,
    turnPrefix,
    kept: messages.slice(cut.firstKeptIndex),
  }
}

/**
 * Heuristic size of the transcript if it were compacted now with a summary of
 * `summaryTokens`; null when nothing is old enough to summarize.
 */
export function projectCompactedTokens(
  messages: readonly AgentMessage[],
  keepRecentTokens: number,
  summaryTokens: number,
): number | null {
  const plan = planCompaction(messages, keepRecentTokens)
  if (!plan) return null
  return estimateMessagesTokens(plan.head) + summaryTokens + estimateMessagesTokens(plan.kept)
}

async function summarizePlan(plan: CompactionPlan, options: CompactMessagesOptions): Promise<SummaryResult> {
  const base = {
    ...options,
    maxTokens: options.budget.summaryMaxTokens,
    targetTokens: options.budget.summaryTargetTokens,
  }
  // A turn cut in the middle with no earlier history is summarized as plain
  // history, so the first compaction of a long task gets the full format.
  if (plan.toSummarize.length === 0 || plan.turnPrefix.length === 0) {
    return generateSummary({ ...base, messages: [...plan.toSummarize, ...plan.turnPrefix], previousSummary: plan.previousSummary })
  }
  const history = await generateSummary({ ...base, messages: plan.toSummarize, previousSummary: plan.previousSummary })
  const prefix = await generateSummary({
    ...base,
    messages: plan.turnPrefix,
    mode: 'turnPrefix',
    maxTokens: Math.max(1, Math.floor(base.maxTokens / 2)),
    targetTokens: Math.max(1, Math.floor(base.targetTokens / 2)),
  })
  return {
    text: `${history.text}\n\n---\n\n**Turn Context (split turn):**\n\n${prefix.text}`,
    usage: addUsage(history.usage, prefix.usage),
  }
}

/**
 * Compact a transcript to `[system, summary, ...kept]`. Returns null when
 * there is nothing old enough to summarize. The leading system message is
 * kept by reference so callers that patch it in place keep working.
 */
export async function compactMessages(
  messages: readonly AgentMessage[],
  options: CompactMessagesOptions,
): Promise<CompactionOutcome | null> {
  const plan = planCompaction(messages, options.budget.keepRecentTokens)
  if (!plan) return null

  const tokensBefore = estimateContextTokens(messages).tokens
  const result = await summarizePlan(plan, options)
  if (options.signal?.aborted) throw new CompactionAbortedError()

  const externalActions = mergeExternalActions(
    parseExternalActions(plan.previousSummary),
    collectExternalActions([...plan.toSummarize, ...plan.turnPrefix]),
  )
  const summary = insertExternalActions(result.text, externalActions)
  const now = options.now ?? Date.now
  const compacted = [...plan.head, buildSummaryMessage(summary, now()), ...plan.kept]
  for (const message of plan.kept) {
    if (message.role === 'assistant') staleUsage.add(message)
  }

  return {
    messages: compacted,
    summary,
    externalActions,
    usage: result.usage,
    tokensBefore,
    tokensAfter: estimateMessagesTokens(compacted),
    firstKeptTimestamp: plan.kept[0]?.timestamp ?? null,
    summarizedMessageCount: plan.toSummarize.length + plan.turnPrefix.length,
  }
}
