import { resolveToolName, type ResolvedToolName } from '@axiom/core/contracts'

export type TranslateFn = (key: string) => string

/** Lookup ids as in `lookupToolEntry`; values are message keys under `toolLabels` in the locale files. */
const TOOL_LABEL_KEYS: Readonly<Record<string, string>> = {
  shell: 'shell',
  file_read: 'file_read',
  file_write: 'file_write',
  file_edit: 'file_edit',
  file_list: 'file_list',
  file_send: 'file_send',
  chat_history_read: 'chat_history_read',
  memory_search: 'memory_search',
  skill_list: 'skill_list',
  image_generate: 'image_generate',
  audio_transcribe: 'audio_transcribe',
  web_search: 'web_search',
  web_fetch: 'web_fetch',
  codemode: 'codemode',
  provider_quota: 'provider_quota',

  task_read: 'task_read',
  'task_write': 'task_write',
  'task_write:create': 'task_write_create',
  'task_write:resume': 'task_write_resume',
  'task_write:stop': 'task_write_stop',

  'schedule_read': 'schedule_read',
  'schedule_read:list': 'schedule_read_list',
  'schedule_read:get': 'schedule_read_get',
  'schedule_write': 'schedule_write',
  'schedule_write:create': 'schedule_write_create_task',
  'schedule_write:create:task': 'schedule_write_create_task',
  'schedule_write:create:reminder': 'schedule_write_create_reminder',
  'schedule_write:edit': 'schedule_write_edit',
  'schedule_write:remove': 'schedule_write_remove',

  'email_read': 'email_read',
  'email_read:list': 'email_read_list',
  'email_read:folders': 'email_read_folders',
  'email_read:read': 'email_read_read',
  'email_read:mark_read': 'email_read_mark_read',
  'email_read:mark_unread': 'email_read_mark_unread',
  email_move: 'email_move',
  email_delete: 'email_delete',
  email_send: 'email_send',
  email_download_attachment: 'email_download_attachment',
}

/** Every message key the label table refers to, relative to `toolLabels`. */
export const TOOL_LABEL_MESSAGE_KEYS: readonly string[] = [...new Set(Object.values(TOOL_LABEL_KEYS))]

function lookupIds(resolved: ResolvedToolName): string[] {
  const ids: string[] = []
  if (resolved.action) {
    if (resolved.scheduleType) ids.push(`${resolved.name}:${resolved.action}:${resolved.scheduleType}`)
    ids.push(`${resolved.name}:${resolved.action}`)
  }
  ids.push(resolved.name)
  return ids
}

/**
 * Looks up the entry of a tool call in a table keyed by `tool`,
 * `tool:action` or `tool:action:scheduleType`; the most specific id wins.
 * Legacy names resolve to the tool, action and type they were folded into.
 */
export function lookupToolEntry<T>(table: Readonly<Record<string, T>>, name: string, args?: unknown): T | undefined {
  for (const id of lookupIds(resolveToolName(name, args))) {
    if (Object.prototype.hasOwnProperty.call(table, id)) return table[id]
  }
  return undefined
}

/**
 * The full i18n key of the label for a tool call (legacy names resolve to the
 * tool, action and schedule type they were folded into), or null for tools
 * without a translated label.
 */
export function toolLabelKey(name: string, args?: unknown): string | null {
  const key = lookupToolEntry(TOOL_LABEL_KEYS, name, args)
  return key === undefined ? null : `toolLabels.${key}`
}

/**
 * Human-readable, translated label of a tool call ("Read file", "Search
 * memory"). Unknown tools (e.g. MCP) fall back to mechanical formatting of the
 * current name (`my_tool` → `My tool`).
 */
export function formatToolName(name: string, args: unknown, t: TranslateFn): string {
  const key = toolLabelKey(name, args)
  if (key !== null) return t(key)
  return mechanicalToolName(resolveToolName(name, args).name)
}

function mechanicalToolName(name: string): string {
  const words = name.split(/[_\s]+/).filter(Boolean)
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

/** Keyed by the same lookup ids as the label table (`tool`, `tool:action`, `tool:action:type`). */
const TOOL_SUMMARY: Readonly<Record<string, SummaryPart[]>> = {
  shell: [{ key: 'command' }],
  file_read: PATH_ONLY,
  file_write: PATH_ONLY,
  file_edit: PATH_ONLY,
  file_list: PATH_ONLY,
  file_send: PATH_ONLY,
  audio_transcribe: PATH_ONLY,

  task_read: [{ key: 'status', label: 'status' }, { key: 'trigger_type', label: 'trigger' }, { key: 'limit', label: 'limit' }],
  'task_write:create': [{ key: 'name' }],
  'task_write:resume': [{ key: 'task_id' }],
  'task_write:stop': [{ key: 'task_id' }],

  'schedule_read:get': ID_ONLY,
  'schedule_write:create': [{ key: 'name' }, { key: 'schedule', label: 'schedule' }],
  'schedule_write:edit': [{ key: 'name' }, { key: 'id', label: 'id' }],
  'schedule_write:remove': ID_ONLY,

  chat_history_read: [
    { key: 'query', label: 'query' },
    { key: 'start', label: 'start' },
    { key: 'end', label: 'end' },
    { key: 'limit', label: 'limit' },
  ],

  web_search: QUERY_ONLY,
  web_fetch: [{ key: 'url' }],
  memory_search: QUERY_ONLY,

  'email_read:list': [{ key: 'folder', label: 'folder' }, { key: 'limit', label: 'limit' }],
  'email_read:folders': [{ key: 'account', label: 'account' }],
  'email_read:read': [{ key: 'uid', label: 'uid' }, { key: 'folder', label: 'folder' }],
  'email_read:mark_read': [{ key: 'uids', label: 'uids' }, { key: 'folder', label: 'folder' }],
  'email_read:mark_unread': [{ key: 'uids', label: 'uids' }, { key: 'folder', label: 'folder' }],
  email_move: [{ key: 'uids', label: 'uids' }, { key: 'target_folder', label: 'to' }],
  email_delete: [{ key: 'uids', label: 'uids' }],
  email_download_attachment: [{ key: 'filename' }, { key: 'uid', label: 'uid' }],
  email_send: [{ key: 'to', label: 'to' }, { key: 'subject', label: 'subject' }],

  provider_quota: [{ key: 'providerId' }],
}

/**
 * Builds a one-line summary of the most descriptive arguments of a tool
 * call (file path, shell command, query, …) for display next to the tool
 * name. The summary is looked up per tool and action. Returns null when the
 * tool is unknown or none of its summary arguments are present.
 */
export function getToolCallSummary(toolName: string, args: unknown): string | null {
  const parts = lookupToolEntry(TOOL_SUMMARY, toolName, args)
  if (!parts || typeof args !== 'object' || args === null) return null

  const record = args as Record<string, unknown>
  const isShell = resolveToolName(toolName).name === 'shell'
  const rendered: string[] = []

  for (const part of parts) {
    let value = formatSummaryValue(record[part.key])
    if (value === null) continue
    if (isShell) value = stripLeadingCd(value)
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
