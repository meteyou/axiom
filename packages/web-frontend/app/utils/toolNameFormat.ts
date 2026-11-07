import { currentToolName } from '@axiom/core/contracts'

/**
 * Turns a raw tool identifier such as `file_read` or `email_send` into a
 * human-readable label (`File read`, `Email send`). Legacy names render like
 * the tool they were renamed to.
 */
export function formatToolName(name: string): string {
  const words = currentToolName(name).split(/[_\s]+/).filter(Boolean)
  if (words.length === 0) return name

  const [first, ...rest] = words
  return [first!.charAt(0).toUpperCase() + first!.slice(1).toLowerCase(), ...rest.map(w => w.toLowerCase())].join(' ')
}

interface SummaryPart {
  key: string
  /** When set, rendered as `label: value`; otherwise the bare value. */
  label?: string
}

const PATH_ONLY: SummaryPart[] = [{ key: 'path' }]
const QUERY_ONLY: SummaryPart[] = [{ key: 'query' }]
const ID_ONLY: SummaryPart[] = [{ key: 'id' }]

const TOOL_SUMMARY: Record<string, SummaryPart[]> = {
  shell: [{ key: 'command' }],
  file_read: PATH_ONLY,
  file_write: PATH_ONLY,
  file_edit: PATH_ONLY,
  file_list: PATH_ONLY,
  file_send: PATH_ONLY,
  audio_transcribe: PATH_ONLY,

  create_task: [{ key: 'name' }],
  resume_task: [{ key: 'task_id' }],
  list_tasks: [{ key: 'status', label: 'status' }, { key: 'trigger_type', label: 'trigger' }, { key: 'limit', label: 'limit' }],

  create_cronjob: [{ key: 'name' }, { key: 'schedule', label: 'schedule' }],
  edit_cronjob: [{ key: 'name' }, { key: 'id', label: 'id' }],
  remove_cronjob: ID_ONLY,
  get_cronjob: ID_ONLY,
  create_reminder: [{ key: 'name' }, { key: 'schedule', label: 'schedule' }],

  chat_history_read: [
    { key: 'query', label: 'query' },
    { key: 'start', label: 'start' },
    { key: 'end', label: 'end' },
    { key: 'limit', label: 'limit' },
  ],

  web_search: QUERY_ONLY,
  web_fetch: [{ key: 'url' }],
  memory_search: QUERY_ONLY,

  email_list: [{ key: 'folder', label: 'folder' }, { key: 'limit', label: 'limit' }],
  email_read: [{ key: 'uid', label: 'uid' }, { key: 'folder', label: 'folder' }],
  email_move: [{ key: 'uids', label: 'uids' }, { key: 'target_folder', label: 'to' }],
  email_delete: [{ key: 'uids', label: 'uids' }],
  email_download_attachment: [{ key: 'filename' }, { key: 'uid', label: 'uid' }],
  email_send: [{ key: 'to', label: 'to' }, { key: 'subject', label: 'subject' }],

  provider_quota: [{ key: 'providerId' }],
}

/**
 * Builds a one-line summary of the most descriptive arguments of a tool
 * call (file path, shell command, query, …) for display next to the tool
 * name. Returns null when the tool is unknown or none of its summary
 * arguments are present.
 */
export function getToolCallSummary(toolName: string, args: unknown): string | null {
  const name = currentToolName(toolName)
  const parts = Object.prototype.hasOwnProperty.call(TOOL_SUMMARY, name) ? TOOL_SUMMARY[name] : undefined
  if (!parts || typeof args !== 'object' || args === null) return null

  const record = args as Record<string, unknown>
  const rendered: string[] = []

  for (const part of parts) {
    let value = formatSummaryValue(record[part.key])
    if (value === null) continue
    if (name === 'shell') value = stripLeadingCd(value)
    if (value === '') continue
    rendered.push(part.label ? `${part.label}: ${value}` : value)
  }

  return rendered.length > 0 ? rendered.join(' · ') : null
}

function formatSummaryValue(value: unknown): string | null {
  if (typeof value === 'string') {
    const firstLine = value.trim().split('\n')[0] ?? ''
    return firstLine === '' ? null : firstLine
  }
  if (typeof value === 'number') return String(value)
  if (Array.isArray(value)) {
    const items = value.filter((v): v is string | number => typeof v === 'string' || typeof v === 'number')
    return items.length > 0 ? items.join(', ') : null
  }
  return null
}

// Agents almost always prefix shell commands with `cd <workspace> &&`, which
// adds no information in a one-line summary. The full command is still
// visible in the expanded arguments.
const LEADING_CD = /^\s*cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/

function stripLeadingCd(command: string): string {
  let result = command
  while (LEADING_CD.test(result)) {
    result = result.replace(LEADING_CD, '')
  }
  return result
}
