import { describe, expect, it } from 'vitest'
import { formatToolName } from './toolNameFormat'

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
