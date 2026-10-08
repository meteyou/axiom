import { CONTEXT_COMPACTION_KIND, formatTokenCount } from './contracts/compaction.js'
import type { ContextCompactionInfo, ContextCompactionWarning } from './contracts/compaction.js'
import type { Database } from './database.js'

const WARNING_TEXT: Record<ContextCompactionWarning, string> = {
  window_too_small: 'The model\'s context window is too small for the system prompt, summary and kept messages, '
    + 'so compaction will run often. Use a model with a larger window or lower "Keep recent tokens" in the compaction settings.',
  auto_paused: 'The context is still above the compaction threshold. Automatic compaction is paused until more '
    + 'messages are added; /new starts a fresh conversation.',
}

function statusLine(info: ContextCompactionInfo): string {
  switch (info.status) {
    case 'running':
      return `\u{1F5DC}\uFE0F Compacting context (${formatTokenCount(info.tokensBefore)} tokens)\u2026`
    case 'completed':
      return `\u{1F5DC}\uFE0F Context compacted (${formatTokenCount(info.tokensBefore)} \u2192 ${formatTokenCount(info.tokensAfter ?? 0)} tokens)`
    case 'skipped':
      return `\u{1F5DC}\uFE0F ${info.error ?? 'Nothing to compact yet.'}`
    case 'failed':
      return `\u26A0\uFE0F Context compaction failed: ${info.error ?? 'unknown error'}`
  }
}

/** Plain text for Telegram and history fallbacks. */
export function formatContextCompactionContent(info: ContextCompactionInfo): string {
  const warnings = (info.warnings ?? []).map(warning => `\u26A0\uFE0F ${WARNING_TEXT[warning]}`)
  return [statusLine(info), ...warnings].join('\n')
}

/**
 * Persist a finished compaction as a `context_compaction` chat row so its
 * divider survives a reload. Returns the info with the row id; `running`
 * keepalives are live-only and returned unchanged.
 */
export function saveContextCompactionNotice(
  db: Database,
  notice: { sessionId: string; userId: number | null; info: ContextCompactionInfo },
): ContextCompactionInfo {
  const { info } = notice
  if (info.status === 'running') return info
  const { messageId: _messageId, ...persisted } = info
  try {
    const result = db.prepare(
      'INSERT INTO chat_messages (session_id, user_id, role, content, metadata) VALUES (?, ?, ?, ?, ?)',
    ).run(
      notice.sessionId,
      notice.userId,
      'system',
      formatContextCompactionContent(info),
      JSON.stringify({ kind: CONTEXT_COMPACTION_KIND, ...persisted }),
    )
    return { ...info, messageId: Number(result.lastInsertRowid) }
  } catch (err) {
    console.error('[compaction] Failed to persist compaction notice:', err)
    return info
  }
}
