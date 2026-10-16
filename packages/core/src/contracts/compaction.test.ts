import { describe, expect, it } from 'vitest'
import { formatContextUsage, formatTokenCount, formatTokensAfter, parseContextCompactionInfo } from './compaction.js'
import type { ContextUsageInfo } from './compaction.js'

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

describe('formatTokensAfter', () => {
  it('marks an estimate until the provider reported the real size', () => {
    expect(formatTokensAfter({ tokensAfter: 29_121 })).toBe('~29k')
    expect(formatTokensAfter({ tokensAfter: 33_106, tokensAfterMeasured: true })).toBe('33k')
    expect(parseContextCompactionInfo({ kind: 'context_compaction', compactionId: 'c', tokensAfterMeasured: true })?.tokensAfterMeasured).toBe(true)
  })
})

describe('formatTokenCount', () => {
  it('abbreviates thousands and millions', () => {
    expect(formatTokenCount(950)).toBe('950')
    expect(formatTokenCount(368_000)).toBe('368k')
    expect(formatTokenCount(1_250_000)).toBe('1.3M')
  })
})

describe('formatContextUsage', () => {
  const usage: ContextUsageInfo = {
    tokens: 40_000,
    estimated: false,
    contextWindow: 200_000,
    compactionThreshold: 180_000,
    modelId: 'model-a',
    modelName: 'Model A',
    autoCompaction: true,
    autoCompactionPaused: false,
  }

  it('lists the largest system prompt blocks, tool definitions and chat parts', () => {
    const sections = [
      { key: 'core_memory', tokens: 4_000 },
      { key: 'available_skills', tokens: 2_000 },
      { key: 'agent_rules', tokens: 1_000 },
      { key: 'personality', tokens: 1_000 },
      { key: 'recent_memory', tokens: 800 },
      { key: 'available_tools', tokens: 600 },
      { key: 'axiom_docs', tokens: 400 },
      { key: 'current_date', tokens: 200 },
    ] as const
    const text = formatContextUsage({
      ...usage,
      breakdown: {
        systemPrompt: { tokens: 10_000, sections: [...sections] },
        toolDefinitions: { tokens: 8_000, count: 24 },
        chat: { tokens: 22_000, summary: 0, user: 2_000, assistant: 5_000, toolResults: 15_000 },
      },
    })

    expect(text).toBe([
      '\u{1F9E0} Context: 40k / 200k tokens (20%)',
      'Automatic compaction at 180k (90%)',
      'Model: Model A',
      '',
      'Breakdown (estimated):',
      'System prompt: 10k (25%)',
      '  · Core memory (MEMORY.md): 4k (40%)',
      '  · Skills: 2k (20%)',
      '  · Agent rules (AGENTS.md): 1k (10%)',
      '  · Personality (SOUL.md): 1k (10%)',
      '  · Daily notes: 800 (8%)',
      '  · Tool overview: 600 (6%)',
      '  · 2 more: 600 (6%)',
      'Tool definitions: 8k (20%), 24 tools',
      'Chat: 22k (55%)',
      '  · User messages: 2k (9%)',
      '  · Assistant messages: 5k (23%)',
      '  · Tool results: 15k (68%)',
    ].join('\n'))
  })

  it('keeps the short form without a breakdown', () => {
    expect(formatContextUsage(usage).split('\n')).toHaveLength(3)
  })
})
