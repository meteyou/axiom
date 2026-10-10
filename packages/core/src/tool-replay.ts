export type ToolReplayPolicy = 'safe' | 'unsafe'

/**
 * Whether a tool call that was interrupted by a crash may be repeated blindly.
 * `safe` is reserved for reads and idempotent flag changes; everything that
 * writes, sends, moves, deletes or spawns work stays `unsafe` because its
 * outcome must be verified before a retry.
 */
const TOOL_REPLAY_POLICIES: ReadonlyMap<string, ToolReplayPolicy> = new Map([
  ['read_file', 'safe'],
  ['list_files', 'safe'],
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
  ['search_memories', 'safe'],
  ['read_chat_history', 'safe'],
  ['provider_quota', 'safe'],
  ['list_agent_skills', 'safe'],
  ['transcribe_audio', 'safe'],

  ['shell', 'unsafe'],
  ['write_file', 'unsafe'],
  ['edit_file', 'unsafe'],
  ['email_send', 'unsafe'],
  ['email_move', 'unsafe'],
  ['email_delete', 'unsafe'],
  ['email_download_attachment', 'unsafe'],
  ['create_task', 'unsafe'],
  ['resume_task', 'unsafe'],
  ['create_cronjob', 'unsafe'],
  ['edit_cronjob', 'unsafe'],
  ['remove_cronjob', 'unsafe'],
  ['create_reminder', 'unsafe'],
  ['send_file_to_user', 'unsafe'],
  ['generate_image', 'unsafe'],
  // A script runs arbitrary nested calls with side effects, so it is never blindly replayable.
  ['codemode', 'unsafe'],
])

export function hasExplicitToolReplayPolicy(toolName: string): boolean {
  return TOOL_REPLAY_POLICIES.has(toolName)
}

/** Unknown tools default to `unsafe` so a forgotten classification fails safe. */
export function getToolReplayPolicy(toolName: string): ToolReplayPolicy {
  return TOOL_REPLAY_POLICIES.get(toolName) ?? 'unsafe'
}
