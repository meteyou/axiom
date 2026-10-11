import { describe, expect, it } from 'vitest'
import { formatTokenCount, parseContextCompactionInfo } from './compaction.js'

describe('parseContextCompactionInfo', () => {
  it('rebuilds a persisted compaction row', () => {
    const info = parseContextCompactionInfo({
      kind: 'context_compaction',
      compactionId: 'c-9',
      status: 'completed',
      reason: 'manual',
      tokensBefore: 120_000,
      tokensAfter: 30_000,
      summary: '## Goal',
      warnings: ['auto_paused', 'bogus'],
      occurredAt: '2026-01-01T00:00:00.000Z',
    }, 5)
    expect(info).toEqual({
      compactionId: 'c-9',
      messageId: 5,
      status: 'completed',
      reason: 'manual',
      tokensBefore: 120_000,
      tokensAfter: 30_000,
      summary: '## Goal',
      warnings: ['auto_paused'],
      occurredAt: '2026-01-01T00:00:00.000Z',
    })
  })

  it('ignores other system rows', () => {
    expect(parseContextCompactionInfo({ kind: 'turn_error', error: 'x' }, 1)).toBeNull()
    expect(parseContextCompactionInfo(null, 1)).toBeNull()
    expect(parseContextCompactionInfo('{"kind":"context_compaction"}')).toBeNull()
  })
})

describe('formatTokenCount', () => {
  it('abbreviates thousands and millions', () => {
    expect(formatTokenCount(950)).toBe('950')
    expect(formatTokenCount(368_000)).toBe('368k')
    expect(formatTokenCount(1_250_000)).toBe('1.3M')
  })
})
