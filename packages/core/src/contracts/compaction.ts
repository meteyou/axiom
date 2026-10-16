export const CONTEXT_COMPACTION_STATUSES = ['running', 'completed', 'skipped', 'failed'] as const
export type ContextCompactionStatus = (typeof CONTEXT_COMPACTION_STATUSES)[number]

export const CONTEXT_COMPACTION_REASONS = ['threshold', 'overflow', 'manual'] as const
export type ContextCompactionReason = (typeof CONTEXT_COMPACTION_REASONS)[number]

/**
 * Problems a finished compaction reports to the user:
 * - `window_too_small`: system prompt + summary + kept tail leave too little
 *   headroom below the trigger, so compaction will re-trigger often
 * - `auto_paused`: the compaction could not get the context below the
 *   trigger; automatic compaction waits until the conversation has grown
 */
export const CONTEXT_COMPACTION_WARNINGS = ['window_too_small', 'auto_paused'] as const
export type ContextCompactionWarning = (typeof CONTEXT_COMPACTION_WARNINGS)[number]

/**
 * Machine-readable payload of a `compaction` chunk and of the
 * `context_compaction` chat row a finished compaction persists. `running` is
 * live-only and repeats while the summary call is in flight, which also keeps
 * the stall watchdog from mistaking a long summary for a dead provider.
 */
export interface ContextCompactionInfo {
  compactionId: string
  status: ContextCompactionStatus
  reason: ContextCompactionReason
  tokensBefore: number
  /**
   * Context size right after the compaction: a heuristic estimate at first,
   * replaced by the provider-reported size once the next response arrives.
   */
  tokensAfter?: number
  /** `tokensAfter` comes from the provider's usage report, not the estimate. */
  tokensAfterMeasured?: boolean
  summary?: string
  /** Why the compaction was skipped or failed. */
  error?: string
  warnings?: ContextCompactionWarning[]
  /** `chat_messages` row id of the persisted notice, when persisted. */
  messageId?: number
  occurredAt: string
}

/**
 * Blocks of the main agent's system prompt, keyed by their XML tag, with the
 * label `/context` shows. `other` covers prompt text outside the known blocks.
 */
const SYSTEM_PROMPT_SECTION_LABELS = {
  personality: 'Personality (SOUL.md)',
  instructions: 'Base instructions',
  agent_rules: 'Agent rules (AGENTS.md)',
  core_memory: 'Core memory (MEMORY.md)',
  recent_memory: 'Daily notes',
  current_user: 'Current user',
  user_profile: 'User profile',
  user_profiles_path: 'User profiles path',
  available_tools: 'Tool overview',
  available_providers: 'Providers & models',
  wiki_pages: 'Wiki pages',
  memory_paths: 'Memory paths',
  shared_data_rules: 'Shared data rules',
  axiom_docs: 'Docs',
  agent_skills: 'Skill creation',
  available_skills: 'Skills',
  task_system: 'Task system',
  workspace: 'Workspace',
  current_date: 'Current date',
  language: 'Language',
  channel_context: 'Channel context',
  codemode: 'Codemode',
  other: 'Other',
} as const

export type SystemPromptSectionKey = keyof typeof SYSTEM_PROMPT_SECTION_LABELS

export interface ContextBreakdownSection {
  key: SystemPromptSectionKey
  tokens: number
}

/**
 * Where the context comes from. Always a heuristic split: providers only
 * report totals. The parts add up to `ContextUsageInfo.tokens`.
 */
export interface ContextUsageBreakdown {
  systemPrompt: {
    tokens: number
    /** Largest first; sections without tokens are left out. */
    sections: ContextBreakdownSection[]
  }
  /** JSON schemas of the tools declared to the model. */
  toolDefinitions: { tokens: number; count: number }
  chat: {
    tokens: number
    /** Summary of the last compaction. */
    summary: number
    user: number
    /** Answers, thinking and tool calls. */
    assistant: number
    toolResults: number
  }
}

/** How full the main agent's context window is, for the chat header and `/context`. */
export interface ContextUsageInfo {
  tokens: number
  /** No provider usage since the session started or the last compaction; `tokens` is a heuristic. */
  estimated: boolean
  contextWindow: number
  /** Automatic compaction starts once the context grows beyond this. */
  compactionThreshold: number
  modelId: string
  modelName: string
  autoCompaction: boolean
  /** Automatic compaction is paused because the last one could not get below the threshold. */
  autoCompactionPaused: boolean
  breakdown?: ContextUsageBreakdown
}

export function contextUsagePercent(tokens: number, contextWindow: number): number {
  return contextWindow > 0 ? Math.min(100, Math.round((tokens / contextWindow) * 100)) : 0
}

/** Plain-text summary for `/context`. */
export function formatContextUsage(info: ContextUsageInfo): string {
  const tokens = `${info.estimated ? '~' : ''}${formatTokenCount(info.tokens)}`
  const compaction = !info.autoCompaction
    ? 'Automatic compaction: off'
    : info.autoCompactionPaused
      ? 'Automatic compaction: paused, the context is still above the threshold'
      : `Automatic compaction at ${formatTokenCount(info.compactionThreshold)} `
        + `(${contextUsagePercent(info.compactionThreshold, info.contextWindow)}%)`
  const lines = [
    `\u{1F9E0} Context: ${tokens} / ${formatTokenCount(info.contextWindow)} tokens `
      + `(${contextUsagePercent(info.tokens, info.contextWindow)}%)`,
    compaction,
    `Model: ${info.modelName}`,
  ]
  if (info.breakdown && info.tokens > 0) lines.push('', ...formatContextBreakdown(info.breakdown, info.tokens))
  return lines.join('\n')
}

const BREAKDOWN_SECTION_LINES = 6

const CHAT_PART_LABELS = {
  summary: 'Compaction summary',
  user: 'User messages',
  assistant: 'Assistant messages',
  toolResults: 'Tool results',
} as const

function breakdownLine(label: string, tokens: number, whole: number, indent = false): string {
  return `${indent ? '  · ' : ''}${label}: ${formatTokenCount(tokens)} (${contextUsagePercent(tokens, whole)}%)`
}

/**
 * No `~` per value: the web chat renders replies as Markdown, where several
 * `~` in one paragraph can turn into strikethrough.
 */
function formatContextBreakdown(breakdown: ContextUsageBreakdown, total: number): string[] {
  const { systemPrompt, toolDefinitions, chat } = breakdown
  const shown = systemPrompt.sections.slice(0, BREAKDOWN_SECTION_LINES)
  const rest = systemPrompt.sections.slice(BREAKDOWN_SECTION_LINES)
  const restTokens = rest.reduce((sum, section) => sum + section.tokens, 0)
  const chatParts = (Object.keys(CHAT_PART_LABELS) as (keyof typeof CHAT_PART_LABELS)[]).filter(part => chat[part] > 0)
  return [
    'Breakdown (estimated):',
    breakdownLine('System prompt', systemPrompt.tokens, total),
    ...shown.map(section => breakdownLine(SYSTEM_PROMPT_SECTION_LABELS[section.key], section.tokens, systemPrompt.tokens, true)),
    ...(rest.length > 0 ? [breakdownLine(`${rest.length} more`, restTokens, systemPrompt.tokens, true)] : []),
    `${breakdownLine('Tool definitions', toolDefinitions.tokens, total)}, ${toolDefinitions.count} tools`,
    breakdownLine('Chat', chat.tokens, total),
    ...chatParts.map(part => breakdownLine(CHAT_PART_LABELS[part], chat[part], chat.tokens, true)),
  ]
}

/** `chat_messages.metadata.kind` marking a persisted compaction notice. */
export const CONTEXT_COMPACTION_KIND = 'context_compaction'

/** `tokensAfter` for display: estimates are marked with `~`. */
export function formatTokensAfter(info: Pick<ContextCompactionInfo, 'tokensAfter' | 'tokensAfterMeasured'>): string {
  const formatted = formatTokenCount(info.tokensAfter ?? 0)
  return info.tokensAfterMeasured ? formatted : `~${formatted}`
}

/** `368000` → `368k`, `1250000` → `1.3M`. */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`
  return String(Math.max(0, Math.round(tokens)))
}

function oneOf<T extends string>(values: readonly T[], value: unknown, fallback: T): T {
  return typeof value === 'string' && (values as readonly string[]).includes(value) ? value as T : fallback
}

/** Rebuild the info of a persisted `context_compaction` row from its parsed metadata. */
export function parseContextCompactionInfo(metadata: unknown, messageId?: number): ContextCompactionInfo | null {
  if (!metadata || typeof metadata !== 'object') return null
  const value = metadata as Record<string, unknown>
  if (value.kind !== CONTEXT_COMPACTION_KIND || typeof value.compactionId !== 'string') return null
  const warnings = Array.isArray(value.warnings)
    ? value.warnings.filter((w): w is ContextCompactionWarning => (CONTEXT_COMPACTION_WARNINGS as readonly unknown[]).includes(w))
    : []
  return {
    compactionId: value.compactionId,
    status: oneOf(CONTEXT_COMPACTION_STATUSES, value.status, 'completed'),
    reason: oneOf(CONTEXT_COMPACTION_REASONS, value.reason, 'threshold'),
    tokensBefore: typeof value.tokensBefore === 'number' ? value.tokensBefore : 0,
    ...(typeof value.tokensAfter === 'number' ? { tokensAfter: value.tokensAfter } : {}),
    ...(value.tokensAfterMeasured === true ? { tokensAfterMeasured: true } : {}),
    ...(typeof value.summary === 'string' ? { summary: value.summary } : {}),
    ...(typeof value.error === 'string' ? { error: value.error } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(messageId !== undefined ? { messageId } : {}),
    occurredAt: typeof value.occurredAt === 'string' ? value.occurredAt : '',
  }
}
