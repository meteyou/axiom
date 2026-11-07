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
  ['web_search', 'safe'],
  ['web_fetch', 'safe'],
  ['email_list', 'safe'],
  ['email_folders', 'safe'],
  // These only toggle the IMAP \Seen flag, which is idempotent.
  ['email_read', 'safe'],
  ['email_mark_read', 'safe'],
  ['email_mark_unread', 'safe'],
  ['list_tasks', 'safe'],
  ['list_cronjobs', 'safe'],
  ['get_cronjob', 'safe'],
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
  ['create_task', 'unsafe'],
  ['resume_task', 'unsafe'],
  ['stop_task', 'unsafe'],
  ['create_cronjob', 'unsafe'],
  ['edit_cronjob', 'unsafe'],
  ['remove_cronjob', 'unsafe'],
  ['create_reminder', 'unsafe'],
  ['file_send', 'unsafe'],
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
