import { describe, expect, it } from 'vitest'
import { formatTaskThinking } from './taskFormat'

const t = (key: string, values?: Record<string, string>) =>
  values ? `${key}(${Object.entries(values).map(([k, v]) => `${k}=${v}`).join(',')})` : key

describe('formatTaskThinking', () => {
  it('returns null for tasks without thinking information', () => {
    expect(formatTaskThinking({ thinkingLevel: null, effectiveThinkingLevel: null }, t)).toBeNull()
  })

  it('marks the background default', () => {
    expect(formatTaskThinking({ thinkingLevel: null, effectiveThinkingLevel: 'low' }, t))
      .toBe('tasks.thinkingDefault(level=tasks.thinkingLevels.low)')
  })

  it('shows an explicit level', () => {
    expect(formatTaskThinking({ thinkingLevel: 'high', effectiveThinkingLevel: 'high' }, t))
      .toBe('tasks.thinking(level=tasks.thinkingLevels.high)')
    expect(formatTaskThinking({ thinkingLevel: 'high', effectiveThinkingLevel: null }, t))
      .toBe('tasks.thinking(level=tasks.thinkingLevels.high)')
  })

  it('shows requested and effective level when clamped', () => {
    expect(formatTaskThinking({ thinkingLevel: 'medium', effectiveThinkingLevel: 'high' }, t))
      .toBe('tasks.thinkingClamped(requested=tasks.thinkingLevels.medium,level=tasks.thinkingLevels.high)')
  })
})
