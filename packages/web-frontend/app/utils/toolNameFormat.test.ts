import { describe, expect, it } from 'vitest'
import { formatToolName, getToolCallSummary } from './toolNameFormat'

describe('formatToolName', () => {
  it('capitalizes single-word tools', () => {
    expect(formatToolName('shell')).toBe('Shell')
  })

  it('replaces underscores with spaces and capitalizes only the first word', () => {
    expect(formatToolName('read_file')).toBe('Read file')
    expect(formatToolName('email_download_attachment')).toBe('Email download attachment')
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
    expect(getToolCallSummary('read_file', { path: 'src/index.ts' })).toBe('src/index.ts')
    expect(getToolCallSummary('write_file', { path: 'a.txt', content: 'x' })).toBe('a.txt')
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

  it('returns null for unknown tools or missing arguments', () => {
    expect(getToolCallSummary('create_task', { name: 'x' })).toBeNull()
    expect(getToolCallSummary('read_file', {})).toBeNull()
    expect(getToolCallSummary('read_file', null)).toBeNull()
    expect(getToolCallSummary('shell', { command: '   ' })).toBeNull()
  })
})
