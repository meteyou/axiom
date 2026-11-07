import { describe, expect, it } from 'vitest'
import { LEGACY_TOOL_NAMES } from '@axiom/core/contracts'
import de from '../i18n/locales/de.json'
import en from '../i18n/locales/en.json'
import { formatToolName, getToolCallSummary, lookupToolEntry, TOOL_LABEL_MESSAGE_KEYS, toolLabelKey } from './toolNameFormat'

const translate = (messages: unknown) => (key: string): string =>
  String(key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], messages) ?? key)
const t = translate(en)

describe('tool label table', () => {
  it.each([['en', en], ['de', de]])('has a %s label for every key', (_name, messages) => {
    for (const key of TOOL_LABEL_MESSAGE_KEYS) {
      expect(typeof (messages.toolLabels as Record<string, unknown>)[key], key).toBe('string')
    }
  })

  it('covers every current tool and every legacy name', () => {
    const tools = [
      'shell', 'file_read', 'file_write', 'file_edit', 'file_list', 'file_send', 'chat_history_read',
      'memory_search', 'skill_list', 'image_generate', 'audio_transcribe', 'web_search', 'web_fetch',
      'codemode', 'provider_quota', 'task_read', 'task_write',
      'schedule_read', 'schedule_write',
      'email_read', 'email_move', 'email_delete', 'email_send', 'email_download_attachment',
    ]
    for (const name of [...tools, ...Object.keys(LEGACY_TOOL_NAMES)]) {
      expect(toolLabelKey(name), name).not.toBeNull()
    }
  })
})

describe('lookupToolEntry', () => {
  const table = {
    'schedule_write': 'tool',
    'schedule_write:create': 'action',
    'schedule_write:create:reminder': 'action+type',
  }

  it('prefers tool + action + schedule type, then tool + action, then tool', () => {
    expect(lookupToolEntry(table, 'schedule_write', { action: 'create', type: 'reminder' })).toBe('action+type')
    expect(lookupToolEntry(table, 'schedule_write', { action: 'create', type: 'task' })).toBe('action')
    expect(lookupToolEntry(table, 'schedule_write', { action: 'remove' })).toBe('tool')
    expect(lookupToolEntry(table, 'schedule_write')).toBe('tool')
  })

  it('resolves legacy names before the lookup', () => {
    expect(lookupToolEntry({ file_read: 'x' }, 'read_file')).toBe('x')
  })

  it('returns undefined for unknown tools', () => {
    expect(lookupToolEntry(table, 'mcp_tool', { action: 'create' })).toBeUndefined()
  })
})

describe('formatToolName', () => {
  it('uses verb-first labels', () => {
    expect(formatToolName('file_read', { path: 'a' }, t)).toBe('Read file')
    expect(formatToolName('memory_search', {}, t)).toBe('Search memory')
    expect(formatToolName('create_reminder', {}, t)).toBe('Create reminder')
    expect(formatToolName('email_mark_read', {}, t)).toBe('Mark email read')
    expect(formatToolName('shell', undefined, t)).toBe('Shell')
  })

  it('translates labels into the UI language', () => {
    const tDe = translate(de)
    expect(formatToolName('file_read', {}, tDe)).toBe('Datei lesen')
    expect(formatToolName('create_cronjob', {}, tDe)).toBe('Cronjob erstellen')
  })

  it('renders legacy tool names like their current names', () => {
    for (const [legacy, target] of Object.entries(LEGACY_TOOL_NAMES)) {
      const args = { action: target.action, type: target.scheduleType }
      expect(formatToolName(legacy, {}, t)).toBe(formatToolName(target.name, args, t))
    }
    expect(formatToolName('read_file', {}, t)).toBe('Read file')
    expect(formatToolName('search_memories', {}, t)).toBe('Search memory')
    expect(formatToolName('send_file_to_user', {}, t)).toBe('Send file')
  })

  it('labels grouped schedule calls by action and type', () => {
    expect(formatToolName('schedule_write', { action: 'create', type: 'task' }, t)).toBe('Create cronjob')
    expect(formatToolName('schedule_write', { action: 'create' }, t)).toBe('Create cronjob')
    expect(formatToolName('schedule_write', { action: 'create', type: 'reminder' }, t)).toBe('Create reminder')
    expect(formatToolName('schedule_write', { action: 'edit', id: 'x' }, t)).toBe('Edit schedule')
    expect(formatToolName('schedule_write', { action: 'remove', id: 'x' }, t)).toBe('Remove schedule')
    expect(formatToolName('schedule_read', { action: 'list' }, t)).toBe('List schedules')
    expect(formatToolName('schedule_read', { action: 'get', id: 'x' }, t)).toBe('Get schedule')
    expect(formatToolName('schedule_write', {}, t)).toBe('Write schedule')
  })

  it('labels task calls by action, for new and legacy names', () => {
    expect(formatToolName('task_write', { action: 'create', name: 'x' }, t)).toBe('Create task')
    expect(formatToolName('task_write', { action: 'resume', task_id: 'x' }, t)).toBe('Resume task')
    expect(formatToolName('task_write', { action: 'stop', task_id: 'x' }, t)).toBe('Stop task')
    expect(formatToolName('task_read', {}, t)).toBe('List tasks')
    expect(formatToolName('create_task', {}, t)).toBe('Create task')
    expect(formatToolName('resume_task', {}, t)).toBe('Resume task')
    expect(formatToolName('stop_task', {}, t)).toBe('Stop task')
    expect(formatToolName('list_tasks', {}, t)).toBe('List tasks')
    expect(formatToolName('task_write', { action: 'stop' }, translate(de))).toBe('Aufgabe stoppen')
  })

  it('labels email_read calls by action, for new and legacy names', () => {
    expect(formatToolName('email_read', { action: 'list' }, t)).toBe('List emails')
    expect(formatToolName('email_read', { action: 'folders' }, t)).toBe('List email folders')
    expect(formatToolName('email_read', { action: 'read', uid: 1 }, t)).toBe('Read email')
    expect(formatToolName('email_read', { action: 'mark_read', uids: [1] }, t)).toBe('Mark email read')
    expect(formatToolName('email_read', { action: 'mark_unread', uids: [1] }, t)).toBe('Mark email unread')
    expect(formatToolName('email_list', {}, t)).toBe('List emails')
    expect(formatToolName('email_folders', {}, t)).toBe('List email folders')
    expect(formatToolName('email_read', { uid: 1 }, t)).toBe('Read email')
    expect(formatToolName('email_mark_unread', {}, t)).toBe('Mark email unread')
    expect(formatToolName('email_read', { action: 'mark_read' }, translate(de))).toBe('E-Mail als gelesen markieren')
  })

  it('labels legacy cronjob and reminder calls like their grouped actions', () => {
    expect(formatToolName('create_cronjob', {}, t)).toBe('Create cronjob')
    expect(formatToolName('create_reminder', { message: 'x' }, t)).toBe('Create reminder')
    expect(formatToolName('remove_cronjob', { id: 'x' }, t)).toBe('Remove schedule')
    expect(formatToolName('list_cronjobs', {}, t)).toBe('List schedules')
  })

  it('falls back to the tool-level label for actions without their own label', () => {
    expect(toolLabelKey('file_read', { action: 'whatever' })).toBe('toolLabels.file_read')
  })

  it('falls back to mechanical formatting for unknown tools', () => {
    expect(toolLabelKey('mcp_github_create_issue')).toBeNull()
    expect(formatToolName('mcp_github_create_issue', {}, t)).toBe('Mcp github create issue')
    expect(formatToolName('Edit', undefined, t)).toBe('Edit')
    expect(formatToolName('WRITE_FILE', undefined, t)).toBe('Write file')
  })

  it('returns the input unchanged when it contains no words', () => {
    expect(formatToolName('', undefined, t)).toBe('')
  })
})

describe('getToolCallSummary', () => {
  it('returns the path for file tools', () => {
    expect(getToolCallSummary('file_read', { path: 'src/index.ts' })).toBe('src/index.ts')
    expect(getToolCallSummary('file_write', { path: 'a.txt', content: 'x' })).toBe('a.txt')
  })

  it('returns the first line of a shell command', () => {
    expect(getToolCallSummary('shell', { command: 'ls -la\necho done' })).toBe('ls -la')
  })

  it('strips leading cd prefixes from shell commands', () => {
    expect(getToolCallSummary('shell', { command: 'cd /workspace/axiom && grep -n "foo" package.json | head -40' }))
      .toBe('grep -n "foo" package.json | head -40')
    expect(getToolCallSummary('shell', { command: 'cd "/path with spaces"; ls -la' })).toBe('ls -la')
    expect(getToolCallSummary('shell', { command: 'cd a && cd b && pwd' })).toBe('pwd')
    expect(getToolCallSummary('shell', { command: 'cd /workspace' })).toBe('cd /workspace')
  })

  it('resolves legacy tool names for the summary', () => {
    expect(getToolCallSummary('read_file', { path: 'src/index.ts' })).toBe('src/index.ts')
    expect(getToolCallSummary('read_chat_history', { query: 'x' })).toBe('query: x')
    expect(getToolCallSummary('search_memories', { query: 'coffee' })).toBe('coffee')
  })

  it('summarizes task calls per action, for new and legacy names', () => {
    expect(getToolCallSummary('task_write', { action: 'create', name: 'GUI Debug Tool Runner', prompt: 'long…' })).toBe('GUI Debug Tool Runner')
    expect(getToolCallSummary('create_task', { name: 'GUI Debug Tool Runner', prompt: 'long…' })).toBe('GUI Debug Tool Runner')
    expect(getToolCallSummary('task_write', { action: 'resume', task_id: 't1', message: 'yes' })).toBe('t1')
    expect(getToolCallSummary('stop_task', { task_id: 't2' })).toBe('t2')
    expect(getToolCallSummary('task_read', { status: 'running' })).toBe('status: running')
    expect(getToolCallSummary('list_tasks', { limit: 5 })).toBe('limit: 5')
  })

  it('joins multiple labeled arguments for chat_history_read', () => {
    expect(getToolCallSummary('chat_history_read', { query: 'cache Test Task', limit: 30 }))
      .toBe('query: cache Test Task · limit: 30')
    expect(getToolCallSummary('chat_history_read', { start: '2026-08-23', limit: 40 }))
      .toBe('start: 2026-08-23 · limit: 40')
  })

  it('renders array arguments as comma separated lists', () => {
    expect(getToolCallSummary('email_send', { to: ['a@x.de', 'b@x.de'], subject: 'Hi', body: '…' }))
      .toBe('to: a@x.de, b@x.de · subject: Hi')
    expect(getToolCallSummary('email_delete', { uids: [1, 2, 3] })).toBe('uids: 1, 2, 3')
  })

  it('summarizes email_read calls per action, for new and legacy names', () => {
    expect(getToolCallSummary('email_read', { action: 'list', folder: 'INBOX', limit: 20 })).toBe('folder: INBOX · limit: 20')
    expect(getToolCallSummary('email_list', { folder: 'INBOX' })).toBe('folder: INBOX')
    expect(getToolCallSummary('email_read', { action: 'read', uid: 42, folder: 'INBOX' })).toBe('uid: 42 · folder: INBOX')
    expect(getToolCallSummary('email_read', { uid: 42 })).toBe('uid: 42')
    expect(getToolCallSummary('email_read', { action: 'mark_read', uids: [1, 2] })).toBe('uids: 1, 2')
    expect(getToolCallSummary('email_mark_unread', { uids: [3] })).toBe('uids: 3')
  })

  it('summarizes schedule calls per action for new and legacy names', () => {
    expect(getToolCallSummary('schedule_write', { action: 'create', type: 'reminder', name: 'Leave', schedule: '30 17 * * *', prompt: '…' }))
      .toBe('Leave · schedule: 30 17 * * *')
    expect(getToolCallSummary('create_reminder', { name: 'Leave', schedule: '30 17 * * *', message: '…' }))
      .toBe('Leave · schedule: 30 17 * * *')
    expect(getToolCallSummary('schedule_write', { action: 'edit', id: 'abc', name: 'Digest' })).toBe('Digest · id: abc')
    expect(getToolCallSummary('schedule_write', { action: 'remove', id: 'abc' })).toBe('abc')
    expect(getToolCallSummary('remove_cronjob', { id: 'abc' })).toBe('abc')
    expect(getToolCallSummary('schedule_read', { action: 'get', id: 'abc' })).toBe('abc')
    expect(getToolCallSummary('schedule_read', { action: 'list', enabled_only: true })).toBeNull()
  })

  it('returns null for unknown tools or missing arguments', () => {
    expect(getToolCallSummary('skill_list', {})).toBeNull()
    expect(getToolCallSummary('list_cronjobs', { enabled_only: true })).toBeNull()
    expect(getToolCallSummary('file_read', {})).toBeNull()
    expect(getToolCallSummary('file_read', null)).toBeNull()
    expect(getToolCallSummary('shell', { command: '   ' })).toBeNull()
  })
})
