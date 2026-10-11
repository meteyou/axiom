import { CONTEXT_COMPACTION_KIND, formatTokenCount, formatTokensAfter } from './contracts/compaction.js'
import type { ContextCompactionInfo, ContextCompactionWarning } from './contracts/compaction.js'
import type { Database } from './database.js'
import { SESSION_OWNER_NOT_DELETED } from './token-logger.js'

const WARNING_TEXT: Record<ContextCompactionWarning, string> = {
  window_too_small: 'The model\'s context window is too small for the system prompt, summary and kept messages, '
    + 'so compaction will run often. Use a model with a larger context window.',
  auto_paused: 'The context is still above the compaction threshold. Automatic compaction is paused until more '
    + 'messages are added; /new starts a fresh conversation.',
}

function statusLine(info: ContextCompactionInfo): string {
  switch (info.status) {
    case 'running':
      return `\u{1F5DC}\uFE0F Compacting context (${formatTokenCount(info.tokensBefore)} tokens)\u2026`
    case 'completed':
      return `\u{1F5DC}\uFE0F Context compacted (${formatTokenCount(info.tokensBefore)} \u2192 ${formatTokensAfter(info)} tokens)`
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
 * divider survives a reload. A later event for the same compaction (the
 * measured `tokensAfter`) updates that row in place. Returns the info with the
 * row id; `running` keepalives are live-only and returned unchanged.
 */
export function saveContextCompactionNotice(
  db: Database,
  notice: { sessionId: string; userId: number | null; info: ContextCompactionInfo },
): ContextCompactionInfo {
  const { info } = notice
  if (info.status === 'running') return info
  const { messageId: _messageId, ...persisted } = info
  const content = formatContextCompactionContent(info)
  const metadata = JSON.stringify({ kind: CONTEXT_COMPACTION_KIND, ...persisted })
  try {
    const existing = db.prepare(
      `SELECT id FROM chat_messages
       WHERE session_id = ? AND role = 'system'
         AND json_extract(metadata, '$.kind') = ? AND json_extract(metadata, '$.compactionId') = ?`,
    ).get(notice.sessionId, CONTEXT_COMPACTION_KIND, info.compactionId) as { id: number } | undefined
    if (existing) {
      db.prepare('UPDATE chat_messages SET content = ?, metadata = ? WHERE id = ?').run(content, metadata, existing.id)
      return { ...info, messageId: existing.id }
    }
    // A compaction can finish after its user was purged; a row written then would survive the purge.
    const result = db.prepare(
      `INSERT INTO chat_messages (session_id, user_id, role, content, metadata)
       SELECT ?, ?, ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM users WHERE id = ? AND deleted_at IS NOT NULL)
         AND ${SESSION_OWNER_NOT_DELETED}`,
    ).run(notice.sessionId, notice.userId, 'system', content, metadata, notice.userId, notice.sessionId)
    if (result.changes === 0) return info
    return { ...info, messageId: Number(result.lastInsertRowid) }
  } catch (err) {
    console.error('[compaction] Failed to persist compaction notice:', err)
    return info
  }
}
