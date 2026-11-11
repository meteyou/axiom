import { resolveToolName } from './contracts/tool-names.js'

export type ToolReplayPolicy = 'safe' | 'unsafe'

/** Grouped tools classify per action; actions missing from the map are `unsafe`. */
type ToolReplayClassification = ToolReplayPolicy | Readonly<Record<string, ToolReplayPolicy>>

/**
 * Whether a tool call that was interrupted by a crash may be repeated blindly.
 * `safe` is reserved for reads and idempotent flag changes; everything that
 * writes, sends, moves, deletes or spawns work stays `unsafe` because its
 * outcome must be verified before a retry.
 */
const TOOL_REPLAY_POLICIES: ReadonlyMap<string, ToolReplayClassification> = new Map<string, ToolReplayClassification>([
  ['file_read', 'safe'],
  ['file_list', 'safe'],
  ['file_stats', 'safe'],
  ['file_search', 'safe'],
  ['web_search', 'safe'],
  ['web_fetch', 'safe'],
  // read and the flag actions only toggle the IMAP \Seen flag, which is idempotent.
  ['email_read', { list: 'safe', folders: 'safe', read: 'safe', mark_read: 'safe', mark_unread: 'safe' }],
  ['task_read', 'safe'],
  ['schedule_read', { list: 'safe', get: 'safe' }],
  ['memory_search', 'safe'],
  ['chat_history_read', 'safe'],
  ['provider_quota', 'safe'],
  ['skill_list', 'safe'],
  ['audio_transcribe', 'safe'],

  ['shell', 'unsafe'],
  ['file_write', 'unsafe'],
  ['file_edit', 'unsafe'],
  ['email_send', 'unsafe'],
  ['email_move', 'unsafe'],
  ['email_delete', 'unsafe'],
  ['email_download_attachment', 'unsafe'],
  ['task_write', { create: 'unsafe', resume: 'unsafe', stop: 'unsafe' }],
  ['schedule_write', { create: 'unsafe', edit: 'unsafe', remove: 'unsafe' }],
  ['file_send', 'unsafe'],
  ['audio_send', 'unsafe'],
  ['image_generate', 'unsafe'],
  // A script runs arbitrary nested calls with side effects, so it is never blindly replayable.
  ['codemode', 'unsafe'],
])

export function hasExplicitToolReplayPolicy(toolName: string): boolean {
  return TOOL_REPLAY_POLICIES.has(resolveToolName(toolName).name)
}

/**
 * Legacy names resolve through the central mapping, so journal entries written
 * before a rename keep their classification. Unknown tools and actions default
 * to `unsafe` so a forgotten classification fails safe.
 */
export function getToolReplayPolicy(toolName: string, args?: unknown): ToolReplayPolicy {
  const { name, action } = resolveToolName(toolName, args)
  const classification = TOOL_REPLAY_POLICIES.get(name)
  if (classification === undefined) return 'unsafe'
  if (typeof classification === 'string') return classification
  if (action === undefined || !Object.prototype.hasOwnProperty.call(classification, action)) return 'unsafe'
  return classification[action]!
}
