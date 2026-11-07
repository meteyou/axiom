import { describe, expect, it } from 'vitest'
import { formatToolName, getToolCallSummary } from './toolNameFormat'

describe('formatToolName', () => {
  it('capitalizes single-word tools', () => {
    expect(formatToolName('shell')).toBe('Shell')
  })

  it('replaces underscores with spaces and capitalizes only the first word', () => {
    expect(formatToolName('file_read')).toBe('File read')
    expect(formatToolName('email_download_attachment')).toBe('Email download attachment')
  })

  it('renders legacy tool names like their current names', () => {
    expect(formatToolName('read_file')).toBe('File read')
    expect(formatToolName('search_memories')).toBe('Memory search')
    expect(formatToolName('send_file_to_user')).toBe('File send')
  })

  it('normalizes already capitalized identifiers', () => {
    expect(formatToolName('Edit')).toBe('Edit')
    expect(formatToolName('WRITE_FILE')).toBe('Write file')
  })

  it('returns the input unchanged when it contains no words', () => {
    expect(formatToolName('')).toBe('')
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

  it('shows the task name for create_task', () => {
    expect(getToolCallSummary('create_task', { name: 'GUI Debug Tool Runner', prompt: 'long…' })).toBe('GUI Debug Tool Runner')
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

  it('returns null for unknown tools or missing arguments', () => {
    expect(getToolCallSummary('skill_list', {})).toBeNull()
    expect(getToolCallSummary('list_cronjobs', { enabled_only: true })).toBeNull()
    expect(getToolCallSummary('file_read', {})).toBeNull()
    expect(getToolCallSummary('file_read', null)).toBeNull()
    expect(getToolCallSummary('shell', { command: '   ' })).toBeNull()
  })
})
